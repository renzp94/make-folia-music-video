// 并行分片渲染：把帧区间切成 W 段，每段一个 Chrome 实例，各自渲染并直接落盘。
import { launchChrome, connectCdp, killChrome, type CdpClient } from './cdp.ts';
import { mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { join, extname } from 'node:path';

/**
 * 逐帧各阶段耗时统计。设 `FOLIA_PROFILE=1` 启用，每片跑完汇总一行。
 *
 * 为什么要它：19.7 fps（50ms/帧）的构成一直没人量过 —— 截图编码、CDP 往返、
 * 写盘各占多少，决定了该往哪儿优化。见 docs/RENDER-PIPELINE.md §七「第 0 步」。
 *
 * 关键指标不是各分项，而是 **wall（整帧时长）减去各分项之和** —— 那部分是
 * 隐性等待（合成器节流之类），不属于任何一次我们自己发的调用。
 */
const PROFILE = process.env.FOLIA_PROFILE === '1';
type ProfileAcc = {
  wall: number; setLine: number; frame: number; capture: number; decode: number; write: number; frames: number;
};
const newProfileAcc = (): ProfileAcc =>
  ({ wall: 0, setLine: 0, frame: 0, capture: 0, decode: 0, write: 0, frames: 0 });

function reportProfile(acc: ProfileAcc, label: string): void {
  const n = acc.frames || 1;
  const sum = acc.setLine + acc.frame + acc.capture + acc.decode + acc.write;
  const ms = (v: number) => (v / n).toFixed(1).padStart(5);
  console.log(
    `[profile ${label}] ${acc.frames} 帧，每帧均值(ms)：` +
    `wall=${ms(acc.wall)} | setLine=${ms(acc.setLine)} frame=${ms(acc.frame)} ` +
    `capture=${ms(acc.capture)} decode=${ms(acc.decode)} write=${ms(acc.write)} ` +
    `| 分项和=${(sum / n).toFixed(1)} 未归属=${((acc.wall - sum) / n).toFixed(1)}`,
  );
}

const DRIVER_SRC = `
(() => {
  let now = 0; const cbs = new Map(); let id = 1;
  globalThis.__frame = { tick(ms) { now = ms;
    for (const [k, cb] of [...cbs.entries()]) { if (!cbs.has(k)) continue; cbs.delete(k);
      try { cb(ms); } catch (e) { console.error('rAF 抛错', e); } } } };
  globalThis.requestAnimationFrame = (cb) => { const i = id++; cbs.set(i, cb); return i; };
  globalThis.cancelAnimationFrame = (i) => { cbs.delete(i); };
  const T0 = 1700000000000;
  Date.now = () => T0 + now;
  performance.now = () => now;
})();`;

function serveStatic(dir: string): { url: string; stop: () => void } {
  const MIME: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
                 '.wav': 'audio/wav', '.png': 'image/png', '.json': 'application/json' };
  const server = Bun.serve({
    hostname: '127.0.0.1', port: 0,
    fetch(req) {
      const p = join(dir, decodeURIComponent(new URL(req.url).pathname));
      if (!p.startsWith(dir) || !existsSync(p)) return new Response('404', { status: 404 });
      return new Response(Bun.file(p), { headers: { 'Content-Type': MIME[extname(p)] ?? 'application/octet-stream', 'Cache-Control': 'no-store' } });
    },
  });
  return { url: `http://127.0.0.1:${server.port}`, stop: () => server.stop(true) };
}

async function evaluate(send: CdpClient['send'], expr: string): Promise<unknown> {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }) as {
    exceptionDetails?: { text: string }; result?: { value?: unknown };
  };
  if (r.exceptionDetails) throw new Error(`页面出错: ${r.exceptionDetails.text}`);
  return r.result?.value;
}

/** 一帧的音频/行号数据（render.ts 算好后喂给页面）。 */
export interface SpecFrame {
  power: number; bass: number; lowMid: number; mid: number;
  vocal: number; treble: number; lineIndex: number;
}

/** renderRange 的参数。 */
interface RenderRangeArgs {
  siteUrl: string;
  /** 落盘模式的目标目录。与 onFrameData 二选一。 */
  framesDir?: string;
  /**
   * 流式模式：每渲好一帧就回调（Buffer 是编码后的 jpg 字节）。
   * 与 framesDir 二选一 —— 给了这个就不落盘。
   */
  onFrameData?: (data: Buffer) => Promise<void>;
  from: number; to: number; warmup?: number;
  /** 外部取消信号（界面上的「停止渲染」）。 */ signal?: AbortSignal;
  /** 封面 data URL（莫奈等模式右侧的肖像图）。 */ cover?: string | null;
  fps: number; foliaLines: unknown; specFrames: SpecFrame[];
  width: number; height: number; mode: string; background: string;
  theme: unknown; tunings: unknown; fmt: string; quality: number;
  onFrame: () => void;
}

/** 渲染 [from, to) 帧区间，直接写入 framesDir（文件名用全局序号）。 */
async function renderRange({ siteUrl, framesDir, onFrameData, from, to, warmup = 0, fps, foliaLines, specFrames,
                             width, height, mode, background, theme, tunings, fmt, quality, onFrame,
                             signal, cover }: RenderRangeArgs): Promise<void> {
  const browser = await launchChrome({ width, height });
  const cdp = await connectCdp(browser);
  const { send } = cdp;
  try {
    await send('Page.enable'); await send('Runtime.enable');
    await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
    await send('Page.addScriptToEvaluateOnNewDocument', { source: DRIVER_SRC });
    await send('Page.navigate', { url: `${siteUrl}/index.html` });
    for (let i = 0; i < 200; i++) {
      if (await evaluate(send, 'document.readyState') === 'complete') break;
      await new Promise((r) => setTimeout(r, 50));
    }
    const args = { foliaLines, mode, background, theme, tunings, cover };
    await evaluate(send, `(async () => {
      const mod = await import('./visualizer.js');
      const audio = mod.createSilentAudio();
      const t = mod.motionValue(0);
      const A = ${JSON.stringify(args)};
      globalThis.__mount = { mod, audio, t };
      globalThis.__lineIdx = -2;
      globalThis.__props = {
        mode: A.mode, currentTime: t, currentLineIndex: -1, lines: A.foliaLines,
        // 出厂值打底、调用方传的覆盖：只传 animationIntensity 时其余颜色不会被清空
        theme: { name:'Folia', backgroundColor:'#29292b', primaryColor:'#f4f4f5',
                 accentColor:'#f4f4f5', secondaryColor:'#71717a',
                 fontStyle:'sans', animationIntensity:'normal', ...(A.theme ?? {}) },
        audioPower: audio.audioPower, audioBands: audio.audioBands,
        background: { mode: A.background }, visualizerTunings: A.tunings,
        paused: false, staticMode: false, isDaylight: false,
        // 封面是 data URL（见 src/render.ts 的 loadCover）；没有图时为 null，
        // 只有莫奈这类用封面的模式会因此留白，其余模式不受影响。
        seed: 'render', coverUrl: A.cover ?? null, showText: true, onLyricLineSeek: () => {},
      };
      // 行索引只能靠 props 传（bundle 期望调用方算，和上游 App.tsx 一致）。
      // 两条都是实测出来的硬约束，缺一条画面就不会跟着行变：
      //   1) 用 updateVisualizer，不要重复 mountVisualizer —— 重挂会把整棵渲染树连动画一起重建；
      //   2) props 必须换**新对象**。原地改字段再传回去，React 拿到的新旧 props 是同一个引用，
      //      浅比较直接相等 → bail out，画面永远停在第一次渲染的内容上。
      globalThis.__setLine = async (idx, timeSec) => {
        if (idx === globalThis.__lineIdx) return '(noop)';
        globalThis.__lineIdx = idx;
        // 顺序要紧，和插件的 rAF tick 一致（echo-folia-plugin/index.js:1336-1357）：
        // 先对齐 currentTime 再 render。反过来的话 React 这一帧读到的还是上一帧的
        // 时间，新行会按旧时间点挂载，高亮和位置都滞后 —— 症状就是「音唱完了字才出来」。
        globalThis.__mount.t.set(timeSec);
        globalThis.__props = { ...globalThis.__props, currentLineIndex: idx };
        mod.updateVisualizer(globalThis.__props);
        // React 的 render 是异步调度的，紧接着的 tick / 截图跑在它 flush 之前，
        // 拍下来的还是旧行。让出一个宏任务等 commit 落定。
        await new Promise((r) => setTimeout(r, 50));
        // 退出的行会滞留在 DOM 里：AnimatePresence 的 exit 动画在冻结/手动驱动的 rAF
        // 下收敛不了，于是旧行越积越多、互相叠字（画面看起来「越来越糊」）。
        // 正常只该有 1~2 行；超了就整树重置一次，代价是这一下没有过渡动画。
        const rows = document.getElementById('root').querySelectorAll('.flex.flex-wrap').length;
        if (rows > 2) {
          mod.unmountVisualizer();
          mod.mountVisualizer(document.getElementById('root'), globalThis.__props);
          await new Promise((r) => setTimeout(r, 50));
          return 'reset(' + rows + ')';
        }
        return 1;
      };
      mod.mountVisualizer(document.getElementById('root'), globalThis.__props);
      return 'ok';
    })()`);
    // React 的首次渲染是异步的。不等它 flush 完就进逐帧 updateVisualizer，后续每一次
    // 更新都会被丢掉 —— 实测症状是 __lineIdx 一路正确推进、画面却永远停在第 1 行。
    await new Promise((r) => setTimeout(r, 400));

    const shotOpts: Record<string, unknown> = fmt === 'jpeg' ? { format: 'jpeg', quality } : { format: fmt };
    // 预热：从 from-warmup 一路推过来，让 Folia 内部的平滑/缓动/行推进收敛到正确状态，
    // 再开始正式出帧。否则分片起点的时间跳跃会让动画停在未收敛的状态上。
    const start = Math.max(0, from - warmup);
    let sentLine = -2;
    if (PROFILE) console.log(`[profile] 片 ${from}~${to} 起跑（预热 ${from - start} 帧）`);
    const acc = PROFILE ? newProfileAcc() : null;
    for (let f = start; f < to; f++) {
      if (signal?.aborted) throw new Error('已取消');
      const wall0 = acc ? performance.now() : 0;
      const writing = f >= from;
      const timeSec = f / fps;
      const b = specFrames[f];
      // 换行单独走一次往返：React 的 render 是异步的，和它写在同一个同步块里的
      // tick 推的还是旧树，新行的 enter 动画要等下一次让出事件循环才开始。
      // 只在行真的变了的时候多这一次，其余帧保持单次往返。
      if (b.lineIndex !== sentLine) {
        const t0 = acc ? performance.now() : 0;
        await evaluate(send, `globalThis.__setLine(${b.lineIndex}, ${timeSec})`);
        if (acc) acc.setLine += performance.now() - t0;
        sentLine = b.lineIndex;
      }
      // 频段值直接内联，spectrum 用紧凑的逗号串（省掉 JSON 数组的括号开销）
      const t1 = acc ? performance.now() : 0;
      await evaluate(send, `(() => {
        const { audio, t } = globalThis.__mount;
        t.set(${timeSec});
        audio.audioPower.set(${b.power});
        audio.audioBands.bass.set(${b.bass});
        audio.audioBands.lowMid.set(${b.lowMid});
        audio.audioBands.mid.set(${b.mid});
        audio.audioBands.vocal.set(${b.vocal});
        audio.audioBands.treble.set(${b.treble});
        globalThis.__frame.tick(${timeSec * 1000});
        return 1;
      })()`);
      if (acc) acc.frame += performance.now() - t1;
      // 预热帧也要截图，只是不落盘：headless 下合成器只在截图时才推进，
      // 而 Framer Motion 的 opacity/transform 走合成层 —— 光 tick 不截图，
      // 动画状态会冻住，进写盘后要瞎上百帧才恢复（分片每片开头都中这一枪）。
      const t2 = acc ? performance.now() : 0;
      const shot = await send('Page.captureScreenshot', shotOpts) as { data: string };
      if (acc) { acc.capture += performance.now() - t2; acc.wall += performance.now() - wall0; acc.frames += 1; }
      if (!writing) continue;
      const t3 = acc ? performance.now() : 0;
      const bytes = Buffer.from(shot.data, 'base64');
      if (acc) acc.decode += performance.now() - t3;
      const t4 = acc ? performance.now() : 0;
      if (onFrameData) {
        // 流式：直接交给调用方（喂进 ffmpeg 的 stdin），中途不落盘
        await onFrameData(bytes);
      } else {
        writeFileSync(join(framesDir!, `f${String(f).padStart(6, '0')}.${fmt === 'jpeg' ? 'jpg' : fmt}`), bytes);
      }
      if (acc) acc.write += performance.now() - t4;
      onFrame();
    }
    if (acc) reportProfile(acc, `${from}~${to}`);
  } finally {
    cdp.close(); killChrome(browser);
  }
}

/** renderFramesParallel 的参数。 */
interface RenderFramesArgs {
  siteUrl: string;
  /** 落盘模式的目标目录。与 onFrameData 二选一。 */
  framesDir?: string;
  /** 流式模式：每帧回调（**仅 workers<=1 时支持**，多片无法保证顺序）。 */
  onFrameData?: (data: Buffer) => Promise<void>;
  totalFrames: number; fps: number;
  foliaLines: unknown; specFrames: SpecFrame[];
  width?: number; height?: number; mode?: string; background?: string;
  theme?: unknown; tunings?: unknown; workers?: number; fmt?: string; quality?: number; warmup?: number;
  onProgress?: (progress: number) => void;
  /** 外部取消信号。 */ signal?: AbortSignal;
  /** 封面 data URL。 */ cover?: string | null;
}

/**
 * 并行渲染整首歌的帧。
 * @returns {Promise<{framesDir:string, ext:string, count:number}>}
 */
export async function renderFramesParallel({
  siteUrl, framesDir, onFrameData, totalFrames, fps, foliaLines, specFrames,
  width = 1920, height = 1080, mode = 'classic', background = 'latent',
  theme, tunings, workers = 1, fmt = 'png', quality = 95, warmup = 180, onProgress = () => {},
  signal, cover,
}: RenderFramesArgs): Promise<{ framesDir?: string; ext: string; count: number }> {
  // 流式模式下没有目录可建；多片模式必须落盘（分片各自写文件，由 ffmpeg 按序号读）
  if (!onFrameData && framesDir) mkdirSync(framesDir, { recursive: true });
  if (onFrameData && workers > 1) {
    throw new Error('流式管道只支持 workers<=1 —— 多片并行下帧的顺序无法保证');
  }
  let done = 0;
  const bump = () => { done += 1; onProgress(done / totalFrames); };

  // 分片粒度与并行度分开：片要小而多，同时运行的 Chrome 仍限 workers 个。
  // 一个 Chrome 连续跑上千帧后会明显劣化（歌词越排越糊、元素堆叠、高亮滞后），
  // 实测同一个 Chrome 跑到 ~1200 帧就开始不对，所以每片控制在 500 帧内。
  // workers <= 1 时**完全不切分**：多分片意味着多个冷启动的 Chrome，每个都要自己
  // 重建动画状态，实测即使预热 180 帧 + 预热期截图，画面仍会出错（退出的行累积、
  // 整句 opacity 停在 0）。目前只有「一个 Chrome 从第 0 帧连续跑到底」能保证正确。
  // 并行方案本身没有废弃，但需要先解决冷启动的状态重建，见 docs/TODO.md 第 2 条。
  const MAX_PER_CHUNK = Number(process.env.FOLIA_CHUNK) || 500;
  const chunkCount = workers <= 1 ? 1 : Math.max(workers, Math.ceil(totalFrames / MAX_PER_CHUNK));
  const chunkSize = Math.ceil(totalFrames / chunkCount);
  const ranges: [number, number][] = [];
  for (let i = 0; i < chunkCount; i++) {
    const from = i * chunkSize;
    const to = Math.min(totalFrames, from + chunkSize);
    if (from < to) ranges.push([from, to]);
  }

  const running = new Set<Promise<void>>();
  while (ranges.length || running.size) {
    // 取消时不再派新片，等已经在跑的收尾（它们各自的 finally 会关掉 Chrome）再抛
    if (signal?.aborted) { await Promise.allSettled([...running]); throw new Error('已取消'); }
    while (running.size < workers && ranges.length) {
      const [from, to] = ranges.shift()!;
      const p = renderRange({ siteUrl, framesDir, onFrameData, from, to, warmup, fps, foliaLines, specFrames,
                              width, height, mode, background, theme, tunings, fmt, quality, onFrame: bump, signal, cover })
        .finally(() => running.delete(p));
      running.add(p);
    }
    if (running.size) await Promise.race(running);
  }
  return { framesDir, ext: fmt === 'jpeg' ? 'jpg' : fmt, count: totalFrames };
}
