// 核心：把 (音频 + 歌词 + 渲染参数) 渲染成 mp4。
//
// 纯 Bun：只用内置的 fetch / WebSocket / Bun.serve / Bun.spawn，不依赖 Playwright，
// 因此可以 `bun build --compile` 打成单文件。
//
// 帧确定性：页面加载前接管 rAF（逐帧手动 tick）+ 冻结时钟，见 src/stitch.ts。

import { EMBEDDED_FFMPEG, EMBEDDED_FFMPEG_VERSION, EMBEDDED_SITE } from './assets.ts';
import { spawn, type SpawnOptions } from 'node:child_process';
import { chmodSync, closeSync, existsSync, openSync, renameSync, rmSync, statSync, writeSync } from 'node:fs';
import { basename, dirname, extname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { computeSpectrumFrames, frameToAudioBytes } from './spectrum.ts';
import { renderFrames, type SpecFrame } from './stitch.ts';
import type { Line } from './lrc.ts';

/** 用哪一份 ffmpeg。`auto` = 有系统就用系统，没有才用内置。 */
export type FfmpegPreference = 'auto' | 'system' | 'embedded';

/** 系统 PATH 里的 ffmpeg 路径，没有则 null。启动时用它决定要不要弹窗问用户。 */
export const systemFfmpeg = (): string | null => Bun.which('ffmpeg');

let cachedAs: FfmpegPreference | null = null;
let cachedPath: string | null = null;

/**
 * 当前生效的偏好。loadPcm / loadCover / 合成 三处都要 spawn，逐个传参太啰嗦 ——
 * 由 renderToMp4 在开头设一次。
 */
let currentPreference: FfmpegPreference = 'auto';

/** 设定 ffmpeg 来源；换来源时丢掉缓存，否则会一直返回上一份。 */
export function setFfmpegPreference(p: FfmpegPreference): void {
  if (p === currentPreference) return;
  currentPreference = p;
  cachedAs = null;
  cachedPath = null;
}

/** 释放进度的回调：0..1。已有缓存时同步报 1。 */
export type ReleaseProgress = (progress: number) => void;

/** 在途的释放任务 —— 多首歌并行时保证只写一次盘。 */
let materializing: Promise<string> | null = null;

/**
 * 把内置的那份 ffmpeg 释放到临时目录并返回路径。
 *
 * 分块写而不是 `await Bun.write()`：那个是一次性写，46 MB 的二进制在中途
 * 一点反馈都没有，界面上看就是「卡住了」。分块的另一个好处是可以先写
 * `.part` 再原子改名 —— 中途失败不会留下一个看着像完整、实则截断的文件。
 */
async function materializeEmbedded(onProgress?: ReleaseProgress): Promise<string> {
  const dest = join(tmpdir(), `make-folia-video-ffmpeg-${process.platform}-${process.arch}`);

  // 已经释放过就直接用（判断依据同上：存在且非空）
  if (existsSync(dest) && statSync(dest).size > 0) {
    onProgress?.(1);
    return dest;
  }
  // 多首歌并行时会有多个任务同时首次进来；复用同一份在途 Promise，
  // 避免两个写盘流同时写同一个 .part。
  if (materializing) {
    return materializing;
  }
  materializing = (async (): Promise<string> => {
    const part = `${dest}.part`;
    const src = Bun.file(EMBEDDED_FFMPEG);
    const total = src.size || 1;
    let written = 0;
    let fd: number | null = null;
    try {
      fd = openSync(part, 'w');
      const reader = src.stream().getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        writeSync(fd, value as Uint8Array);
        written += (value as Uint8Array).length;
        onProgress?.(Math.min(1, written / total));
      }
      closeSync(fd);
      fd = null;
      chmodSync(part, 0o755);
      renameSync(part, dest);
      onProgress?.(1);
      return dest;
    } catch (error) {
      if (fd !== null) { try { closeSync(fd); } catch { /* 关不上也只能算了 */ } }
      rmSync(part, { force: true });
      throw new Error(
        `内置的 ffmpeg 释放失败：${(error as Error).message}\n`
        + '请改用自己的 ffmpeg：macOS 用 brew install ffmpeg。',
      );
    }
  })();
  try {
    return await materializing;
  } finally {
    materializing = null;
  }
}

/**
 * ffmpeg 可执行文件的路径。
 *
 * `preference` 决定用哪一份。用户显式选了 `system` 但 PATH 里其实没有时，这里会
 * **抛错而不是偷偷退回内置的** —— 界面要靠这个错误去问用户是否改用内置的。
 * （静默切换会让「我明明选了自己的 ffmpeg」变成一个查不出来的怪现象。）
 */
export async function resolveFfmpeg(
  preference: FfmpegPreference = 'auto',
  onProgress?: ReleaseProgress,
): Promise<string> {
  if (cachedPath && cachedAs === preference) return cachedPath;

  if (preference === 'system') {
    const system = systemFfmpeg();
    if (!system) throw new FfmpegUnavailableError('PATH 里找不到 ffmpeg');
    cachedAs = 'system'; cachedPath = system;
    return system;
  }

  if (preference === 'embedded') {
    const dest = await materializeEmbedded(onProgress);
    cachedAs = 'embedded'; cachedPath = dest;
    return dest;
  }

  // auto：能用系统的就用系统的（不占磁盘、版本可能更新）
  const system = systemFfmpeg();
  const dest = system ?? await materializeEmbedded(onProgress);
  cachedAs = 'auto'; cachedPath = dest;
  return dest;
}

/** 问一个 ffmpeg 可执行文件的版本号（拿不到就返回 null，不该因此中断流程）。 */
export async function ffmpegVersion(bin: string): Promise<string | null> {
  try {
    const proc = Bun.spawn([bin, '-version'], { stdout: 'pipe', stderr: 'ignore' });
    const out = await new Response(proc.stdout).text();
    return /ffmpeg version (\S+)/.exec(out)?.[1] ?? null;
  } catch {
    return null;
  }
}

/**
 * 用 ffmpeg 读音频时长（秒）。取不到返回 undefined。
 *
 * `ffmpeg -i <文件>` 不给输出文件时会以**非零退出码**结束 —— 那是正常的，
 * 时长信息照样打在 stderr 上，所以这里不看退出码、只解析 stderr。
 *
 * 放在这里（而不是 index.ts 里）是因为 TUI 也要用：联网取词必须把音频的**真实**时长
 * 交给打分，而打分对时长差 >10s 有十倍惩罚，传错会直接选错歌。index.ts 和 tui.tsx
 * 都 import 它，就不必各写一份。
 */
export async function probeDurationSec(
  audioPath: string,
  preference: FfmpegPreference = 'auto',
): Promise<number | undefined> {
  try {
    const proc = Bun.spawn([await resolveFfmpeg(preference), '-i', audioPath],
      { stdin: 'ignore', stdout: 'ignore', stderr: 'pipe' });
    const text = await new Response(proc.stderr).text();
    await proc.exited;
    const m = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(text);
    if (!m) return undefined;
    return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
  } catch {
    return undefined;
  }
}

export { EMBEDDED_FFMPEG_VERSION };

/** 用户指定了 ffmpeg 来源、但那份用不了时抛这个 —— 界面据此提示改用内置的。 */
export class FfmpegUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FfmpegUnavailableError';
  }
}

/** 读音频为 { samples, sampleRate }（经 ffmpeg 转 f32le 单声道）。 */
export async function loadPcm(audioPath: string, sampleRate = 44100): Promise<{ samples: Float32Array; sampleRate: number }> {
  const r = spawn(await resolveFfmpeg(currentPreference), [
    '-v', 'error', '-i', audioPath, '-f', 'f32le', '-ac', '1', '-ar', String(sampleRate), '-',
  // stdout/stderr 是 Node spawn 的简写选项，运行时支持，但 @types/node 的 SpawnOptions 未声明，故断言
  ], { stdout: 'pipe', stderr: 'inherit' } as SpawnOptions);
  const chunks: Buffer[] = [];
  const done = new Promise<void>((res, rej) => r.on('close', (c) => c === 0 ? res() : rej(new Error(`ffmpeg 读音频失败 ${c}`))));
  // stdio 里已声明 stdout: 'pipe'，这里必然非空
  r.stdout!.on('data', (c) => chunks.push(c));
  return done.then(() => {
    const buf = Buffer.concat(chunks);
    const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
    return { samples: new Float32Array(ab), sampleRate };
  });
}

/** 喂给渲染页面的行结构（Folia Line）。 */
export type FoliaLine = {
  startTime: number; endTime: number; fullText: string;
  words: { text: string; startTime: number; endTime: number }[];
  translation?: string; romanization?: string;
};

/**
 * 找封面并转成 data URL（页面里当 <img src> 用，所以必须内联，不能给本地路径）。
 *
 * 优先级：显式指定 > 与音频同名的图片 > 目录里的 cover / folder / 封面。
 * 找不到就返回 null —— 只有莫奈这类用封面的模式会因此留白，其余模式不受影响。
 *
 * 顺便缩到 1024 以内：这张图会作为字符串塞进 CDP 的 evaluate 消息，原图动辄几 MB，
 * 而它实际只当肖像画用，用不上原始分辨率。
 */
export async function loadCover(audioPath: string, explicit?: string | null): Promise<string | null> {
  const dir = dirname(audioPath);
  const stem = basename(audioPath, extname(audioPath));
  const exts = ['.jpg', '.jpeg', '.png', '.webp'];
  const candidates = [
    explicit ?? undefined,
    ...exts.map((e) => join(dir, stem + e)),
    ...exts.flatMap((e) => [join(dir, `cover${e}`), join(dir, `folder${e}`), join(dir, `封面${e}`)]),
  ].filter((v): v is string => Boolean(v) && existsSync(v!));

  const hit = candidates[0];
  if (!hit) return null;

  const lower = hit.toLowerCase();
  const mime = lower.endsWith('.png') ? 'image/png'
    : lower.endsWith('.webp') ? 'image/webp' : 'image/jpeg';

  // 用 ffmpeg 统一转成 jpeg 并限制边长，既缩小体积又抹平格式差异
  const proc = spawn(await resolveFfmpeg(currentPreference), [
    '-v', 'error', '-i', hit,
    '-vf', "scale='min(1024,iw)':'min(1024,ih)':force_original_aspect_ratio=decrease",
    '-f', 'image2', '-c:v', 'mjpeg', '-q:v', '3', '-',
  ], { stdout: 'pipe', stderr: 'inherit' } as SpawnOptions);
  const chunks: Buffer[] = [];
  proc.stdout?.on('data', (c: Buffer) => chunks.push(c));
  const code = await new Promise<number | null>((res) => proc.on('close', res));
  if (code !== 0 || chunks.length === 0) return null;
  return `data:${mime};base64,${Buffer.concat(chunks).toString('base64')}`;
}

export const toFoliaLines = (lines: Line[]): FoliaLine[] => lines.map((l) => ({
  startTime: l.startTime, endTime: l.endTime, fullText: l.text ?? l.fullText,
  words: (l.words ?? []).map((w) => ({ text: w.text, startTime: w.startTime, endTime: w.endTime })),
  ...(l.translation ? { translation: l.translation } : {}),
  ...(l.romanization ? { romanization: l.romanization } : {}),
}));

/** 在按 startTime 升序的 lines 上二分，返回最后一个 startTime <= t 的下标；无则 -1。 */
export function findLineIndex(lines: { startTime: number }[], t: number): number {
  let lo = 0, hi = lines.length - 1, found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (lines[mid].startTime <= t) { found = mid; lo = mid + 1; } else { hi = mid - 1; }
  }
  return found;
}

/** 极简静态服务（file:// 下 ES module 会被 CORS 拦）。 */
function serveStatic(dir: string): { url: string; stop: () => void } {
  const MIME: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
                 '.wav': 'audio/wav', '.png': 'image/png', '.json': 'application/json' };
  const server = Bun.serve({
    hostname: '127.0.0.1', port: 0,
    fetch(req) {
      const pathname = decodeURIComponent(new URL(req.url).pathname);
      const typeOf = (p: string): string => MIME[p.slice(p.lastIndexOf('.'))] ?? 'application/octet-stream';
      // 磁盘上有就用磁盘的 —— 开发时重建了 bundle 立刻生效，不必重新打包。
      // 打包成单文件后磁盘上没有 site/，落到下面内嵌的那份（见 assets.ts）。
      const p = join(dir, pathname);
      if (p.startsWith(dir) && existsSync(p)) {
        return new Response(Bun.file(p), { headers: { 'Content-Type': typeOf(p), 'Cache-Control': 'no-store' } });
      }
      const embedded = EMBEDDED_SITE[pathname];
      if (embedded) {
        return new Response(Bun.file(embedded), { headers: { 'Content-Type': typeOf(pathname), 'Cache-Control': 'no-store' } });
      }
      return new Response('404', { status: 404 });
    },
  });
  return { url: `http://127.0.0.1:${server.port}`, stop: () => server.stop(true) };
}

/** renderToMp4 的渲染参数。 */
export interface RenderOptions {
  width?: number; height?: number; fps?: number;
  mode?: string; background?: string;
  theme?: unknown; tunings?: unknown; crf?: number;
}

/** renderToMp4 的任务描述。 */
export interface RenderJob {
  audioPath: string; lines: Line[]; output: string; siteDir: string;
  /** 封面图路径；不传则自动找与音频同名的图片。会转成 data URL 交给 visualizer。 */
  cover?: string | null;
  /** 用哪一份 ffmpeg。默认 auto —— 有系统就用系统，没有才释放内置的。 */
  ffmpeg?: FfmpegPreference;
  /** 释放内置 ffmpeg 的进度（0..1）。46 MB 的二进制写盘要一两秒，没反馈像是卡住了。 */
  onFfmpegProgress?: (progress: number) => void;
  /**
   * 自动查找封面时的基准路径，默认用 audioPath。
   * 片段渲染（--start）时 audioPath 是 /tmp 下的临时文件，封面得回原音频目录去找。
   */
  coverFrom?: string;
  render?: RenderOptions;
  onProgress?: (progress: number) => void;
  /** ffmpeg 合成阶段的进度（0..1）。逐帧渲染那步的进度走 onProgress。 */
  onEncodeProgress?: (progress: number) => void;
  /** 取消信号：abort 后杀掉 Chrome 与 ffmpeg，并删掉半成品输出。 */
  signal?: AbortSignal;
  onStage?: (stage: string, detail: string) => void;
}

/** renderToMp4 的结果。 */
export interface RenderResult {
  output: string; frames: number; durationSec: number; renderFps: number; seconds: number;
}

/**
 * 渲染一首歌为 mp4。
 * @param {object} job
 * @param {string}  job.audioPath   本地音频文件
 * @param {Array}   job.lines       歌词行（Folia Line 结构或 {text,startTime,endTime,words}）
 * @param {string}  job.output      输出 mp4 路径
 * @param {string}  job.siteDir     含 index.html + visualizer.js/css 的目录
 * @param {object} [job.render]     { width,height,fps,mode,background,theme,tunings,crf }
 * @param {Function} [job.onProgress] (0..1) => void
 * @param {Function} [job.onStage]    (stage, detail) => void
 */
export async function renderToMp4(job: RenderJob): Promise<RenderResult> {
  const { audioPath, lines, output, siteDir, signal, cover, coverFrom, onFfmpegProgress, onProgress = () => {}, onEncodeProgress = () => {}, onStage = () => {} } = job;
  const {
    width = 1920, height = 1080, fps = 60,
    mode = 'classic', background = 'latent',
    theme, tunings, crf = 16,
  } = job.render ?? {};

  // 先定下用哪一份，再解析 —— 用户显式选了系统那份而它不可用时，这里会抛
  // FfmpegUnavailableError，界面据此问是否改用内置的
  setFfmpegPreference(job.ffmpeg ?? 'auto');
  await resolveFfmpeg(currentPreference, onFfmpegProgress);

  const total0 = Date.now();

  // ① 频谱
  onStage('spectrum', '读取音频并计算频谱');
  const { samples, sampleRate } = await loadPcm(audioPath);
  const specFrames = computeSpectrumFrames(samples, sampleRate, fps, 0.6);
  const totalFrames = specFrames.length;
  const foliaLines = toFoliaLines(lines);
  const durationSec = totalFrames / fps;
  onStage('spectrum', `${totalFrames} 帧 / ${durationSec.toFixed(1)} 秒`);

  // ①.5 封面（莫奈这类模式要用；找不到就是 null，不影响别的模式）
  const coverUrl = await loadCover(coverFrom ?? audioPath, cover);
  if (coverUrl) onStage('cover', `封面 ${Math.round(coverUrl.length / 1024)} KB`);

  // ② 逐帧 + ③ 合成
  //
  // **流式管道**：先起 ffmpeg，渲一帧就往它的 stdin 写一帧，全程不落盘。
  // 落盘版本会生成 totalFrames 个 jpg（一整首约 4~6 GB），中途崩掉还得自己清；
  // 管道模式内存里最多压一两帧。
  const site = serveStatic(siteDir);

  const specSlim: SpecFrame[] = specFrames.map((b, i) => {
    const a = frameToAudioBytes(b);
    return { power: a.audioPower, bass: a.bass, lowMid: a.lowMid, mid: a.mid,
             vocal: a.vocal, treble: a.treble, lineIndex: findLineIndex(foliaLines, i / fps) };
  });

  onStage('render', '逐帧（流式管道）');
  // 只累计**逐帧渲染**的耗时：流式模式下渲染和合成是交织的，但 renderFps
  // 要回答的是「每秒渲多少帧」，把合成时间算进来会让这个数偏小。
  let renderSec = 0;

  const ffmpegArgs = (input: string[]): string[] => [
    '-v', 'error', '-y',
    ...input,
    '-i', audioPath,
    '-c:v', 'libx264', '-crf', String(crf), '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '320k', '-shortest',
    // moov 写在文件开头：不加的话要等整个文件写完后播放器才能读到头，
    // 成片动辄几百 MB，看起来就像「文件坏了/打不开」。
    '-movflags', '+faststart',
    // 合成这步动辄好几分钟，不给进度的话界面一直停在上一步的百分比上
    '-progress', 'pipe:1', '-nostats',
    output,
  ];

  // ffmpeg 的 out_time_ms 实际是**微秒**（字段名的历史遗留），除以 1e6 才是秒
  const attachProgress = (ff: ReturnType<typeof spawn>) => {
    let lastEnc = 0;
    ff.stdout?.on('data', (chunk: Buffer) => {
      const m = /out_time_ms=(\d+)/.exec(chunk.toString());
      if (!m || durationSec <= 0) return;
      const p = Math.min(1, Number(m[1]) / 1e6 / durationSec);
      if (p > lastEnc) { lastEnc = p; onEncodeProgress(p); }
    });
  };

  /** 写 stdin 并等背压排空 —— ffmpeg 消费不过来时不能一直灌，否则内存会涨。 */
  const writeFrame = (stream: NodeJS.WritableStream, buf: Buffer): Promise<void> =>
    new Promise<void>((resolve, reject) => {
      const onErr = (e: Error) => reject(e);
      stream.once('error', onErr);
      if (stream.write(buf)) { stream.off('error', onErr); return resolve(); }
      stream.once('drain', () => { stream.off('error', onErr); resolve(); });
    });

  let ff: ReturnType<typeof spawn> | null = null;
  let ffErr = '';
  try {
    ff = spawn(await resolveFfmpeg(currentPreference),
      ffmpegArgs(['-f', 'image2pipe', '-framerate', String(fps), '-i', 'pipe:0']),
      { stdio: ['pipe', 'pipe', 'pipe'], signal } as SpawnOptions);
    // stderr 自己收着：TUI 下直接 inherit 会把 ffmpeg 的报错糊到界面上
    ff.stderr?.on('data', (c: Buffer) => { ffErr = (ffErr + c.toString()).slice(-2000); });
    // spawn 的 signal 被 abort 时会 emit AbortError；不接住就是未捕获异常，
    // 会在界面上糊一段堆栈。真正的取消由下面的 catch 统一处理。
    ff.on('error', (e: Error) => { ffErr += `\n${e.message}`; });
    attachProgress(ff);
    // ffmpeg 提前死掉（比如参数不对）时，写 stdin 会 EPIPE —— 让它冒出来，
    // 否则渲染会白跑到底才在 await ff 那里报错。
    const ffDone = new Promise<number | null>((res) => ff!.on('close', res));
    try {
      const t0 = Date.now();
      await renderFrames({
        siteUrl: site.url, onFrameData: (buf) => writeFrame(ff!.stdin!, buf),
        fps, foliaLines, specFrames: specSlim,
        width, height, mode, background, theme, tunings,
        quality: Number(process.env.FOLIA_JPEG_QUALITY) || 95,
        onProgress, signal, cover: coverUrl,
      });
      renderSec = (Date.now() - t0) / 1000;
      ff.stdin?.end();
    } catch (error) {
      ff.stdin?.destroy();
      throw error;
    }
    const code = await ffDone;
    if (code !== 0) {
      throw new Error(`ffmpeg 合成失败，退出码 ${code}`
        + (ffErr.trim() ? `\n${ffErr.trim().slice(-500)}` : ''));
    }
  } catch (error) {
    // 取消时 ffmpeg 可能还在写 trailer（-movflags +faststart 要 re-open 输出文件）。
    // 必须先杀掉并等它退出，再删半成品 —— 否则它会 re-open 已删掉的文件并刷错误。
    if (ff && ff.exitCode === null && ff.signalCode === null) {
      ff.kill('SIGKILL');
      await new Promise<void>((res) => { ff!.once('close', () => res()); });
    }
    rmSync(output, { force: true });
    throw error;
  } finally {
    site.stop();
  }

  return {
    output, frames: totalFrames, durationSec,
    renderFps: totalFrames / renderSec,
    seconds: (Date.now() - total0) / 1000,
  };
}
