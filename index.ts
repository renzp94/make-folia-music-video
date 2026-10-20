#!/usr/bin/env bun
// folia-video —— 把 Folia 歌词页渲染成 mp4
//
//   folia-video <音频...> [选项]     有参数 → 直接渲染（多首可并行）
//   folia-video                     无参数 → 进 TUI（界面里跑渲染）
import './src/prelude.ts';

import {
  MODE_LABELS, BACKGROUND_LABELS, INTENSITY_LABELS, labelOf, qualityNameOf,
} from './src/labels.ts';   // 必须在任何 ink 相关模块之前执行，见该文件里的说明

import { parseLrc, type Line } from './src/lrc.ts';
import { fetchLyrics, parseTrackName, type LyricSourceId } from './src/lyrics/fetch.ts';
import { renderToMp4, resolveFfmpeg, probeDurationSec } from './src/render.ts';
import { runPool } from './src/batch.ts';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, extname, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

/** 命令行选项（解析后每个 flag 都是 string）。 */
interface Opts {
  _: string[];
  help?: string; h?: string;
  out?: string; offset?: string; start?: string; duration?: string;
  width?: string; height?: string; fps?: string;
  mode?: string; background?: string; intensity?: string;
  crf?: string; jobs?: string; site?: string; cover?: string;
  /** 歌词源。不给就是 qq → kugou → amll 依次试。 */
  source?: string;
  /** 关掉「找不到歌词文件就联网搜」。 */
  noFetch?: string;
}

/** 可选的歌词源，同时也是 `--source` 的合法取值顺序。 */
const LYRIC_SOURCES: readonly LyricSourceId[] = ['kugou', 'qq', 'amll'];

/** 位置参数里哪些算音频（与 TUI 的列表一致）。 */
const AUDIO_EXT = new Set(['.mp3', '.flac', '.wav', '.m4a', '.aac', '.ogg', '.opus']);

/**
 * 找 bundle 所在目录（site/，里面是 9.8 MB 的 visualizer.js + CSS）。
 * 打包成单文件可执行后 `import.meta.url` 指向 /$bunfs 里的虚拟路径，
 * 那里没有 site/ —— 所以还要看可执行文件旁边和当前目录。
 */
function resolveSiteDir(explicit?: string): string {
  const candidates = [
    explicit,
    join(here, 'site'),
    join(dirname(process.execPath), 'site'),
    join(process.cwd(), 'site'),
  ].filter((p): p is string => Boolean(p));
  return candidates.find((p) => existsSync(join(p, 'visualizer.js'))) ?? candidates[0];
}

function parseArgs(argv: string[]): Opts {
  const o: Opts = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const k = a.slice(2);
      const v = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : 'true';
      Object.assign(o, { [k === 'no-fetch' ? 'noFetch' : k]: v });
    } else o._.push(a);
  }
  return o;
}

export async function main(argv = Bun.argv.slice(2)): Promise<number> {
  const o = parseArgs(argv);
  // 越早越好：片段截取那步在 renderToMp4 之前就会 spawn ffmpeg
  try { await resolveFfmpeg(); } catch (e) { console.error((e as Error).message); return 2; }
  if (o.help || o.h) { printHelp(); return 0; }
  if (o._.length === 0) {
    // 无参数 → 进界面。界面退出后才开始渲染，避免渲染日志和 ink 抢终端。
    const { runTui } = await import('./src/tui.tsx');
    const testDir = join(here, 'local-test');
    // 界面自己跑渲染（进度就显示在「开始渲染」按钮下面），退出时整个任务就结束了 ——
    // 所以这里不需要再拿它选好的参数去走一遍命令行流程。
    await runTui({ startDir: existsSync(testDir) ? testDir : process.cwd() });
    return 0;
  }

  // ── 位置参数：音频（可多首）+ 可选的显式 .lrc ───────────────────────────────
  const audios = o._.filter((p) => AUDIO_EXT.has(extname(p).toLowerCase()));
  const explicitLrcs = o._.filter((p) => extname(p).toLowerCase() === '.lrc');
  const unknown = o._.filter((p) => !audios.includes(p) && !explicitLrcs.includes(p));
  if (unknown.length > 0) {
    console.error(`无法识别的参数：${unknown.join(' ')}（音频或 .lrc）`);
    return 2;
  }
  if (audios.length === 0) { console.error('没有指定音频文件。'); return 2; }
  if (explicitLrcs.length > 1) { console.error('只能显式指定一份 .lrc。'); return 2; }

  const multi = audios.length > 1;
  if (multi && explicitLrcs.length > 0) {
    console.error('多首渲染时歌词请用各自同名的 .lrc（或自动获取）；显式 .lrc 只能配单首。');
    return 2;
  }
  if (multi && o.out) { console.error('--out 只能用于单首渲染。'); return 2; }
  for (const audio of audios) {
    if (!existsSync(audio)) { console.error(`找不到音频：${audio}`); return 2; }
  }
  const explicitLrc = explicitLrcs[0] ?? null;
  if (explicitLrc && !existsSync(explicitLrc)) {
    console.error(`找不到歌词文件：${explicitLrc}`);
    return 2;
  }
  if (o.source && !LYRIC_SOURCES.includes(o.source as LyricSourceId)) {
    console.error(`--source 只能是 ${LYRIC_SOURCES.join(' | ')}，收到「${o.source}」。`);
    return 2;
  }
  const jobsLimit = o.jobs === undefined ? 3 : Number(o.jobs);
  if (!Number.isInteger(jobsLimit) || jobsLimit < 1 || jobsLimit > 6) {
    console.error('--jobs 只能是 1..6。');
    return 2;
  }

  // --offset 叠加在 LRC 自带的 [offset:] 上；正值＝歌词提前（与 Folia 的 lyricTimelineOffsetMs 同向）
  const offsetMs = o.offset === undefined ? 0 : Number(o.offset) || 0;
  // 片段渲染：调 offset / 看某一小段效果时，只跑这几秒（比整首快一个数量级）。
  const startSec = o.start === undefined ? 0 : Number(o.start) || 0;
  const clipSec = o.duration === undefined ? 0 : Number(o.duration) || 0;

  const num = (v: string | undefined, d: number): number => (v === undefined ? d : Number(v));
  // 取出来给展示和渲染共用，避免两处各写一遍默认值而漂移
  const mode = o.mode ?? 'classic';
  const background = o.background ?? 'latent';
  const intensity = o.intensity ?? 'normal';
  const outW = num(o.width, 1920);
  const outH = num(o.height, 1080);
  const outFps = num(o.fps, 60);

  const outputs = audios.map((audio) =>
    (multi ? undefined : o.out) ?? join(process.cwd(), `${basename(audio, extname(audio))}.mp4`));
  if (new Set(outputs).size !== outputs.length) {
    console.error('多首音频同名，默认输出会互相覆盖。请把它们放进不同目录，或先逐首用 --out 渲染。');
    return 2;
  }

  const siteDir = resolveSiteDir(o.site);
  if (!existsSync(join(siteDir, 'visualizer.js'))) {
    console.error(`找不到 bundle：${siteDir}\n`
      + '打包版需要把 site/ 放在可执行文件同一个目录下（或显式 --site <目录>）。');
    return 2;
  }

  console.log(multi
    ? `音频    ${audios.length} 首，最多 ${Math.min(jobsLimit, audios.length)} 路并行`
    : `音频    ${audios[0]}`);
  console.log(`效果    ${labelOf(MODE_LABELS, mode)} (${mode})`
    + ` · 背景 ${labelOf(BACKGROUND_LABELS, background)}`
    + ` · 强度 ${labelOf(INTENSITY_LABELS, intensity)}`);
  console.log(`清晰度  ${qualityNameOf(outW, outH)}  ${outW}×${outH} @ ${outFps}fps`);
  if (!multi) { console.log(`输出    ${outputs[0]}`); }
  console.log();

  /** 渲染一首：解析歌词 →（可选）截片段 → renderToMp4。失败直接抛，由 runPool 汇总。 */
  const renderOne = async (audioPath: string, index: number): Promise<void> => {
    const tag = multi ? `[${index + 1}/${audios.length} ${basename(audioPath, extname(audioPath))}] ` : '';
    const output = outputs[index];

    // 歌词：显式指定 > 同名 .lrc > 联网搜（--no-fetch 关掉最后一步）
    let lrcPath = explicitLrc;
    if (!lrcPath) {
      const guess = audioPath.replace(/\.[^.]+$/, '.lrc');
      if (existsSync(guess)) { lrcPath = guess; }
    }

    let lines: Line[];
    let lyricFrom: string;                      // 展示用：这份歌词打哪来
    if (lrcPath) {
      const parsed = parseLrc(readFileSync(lrcPath, 'utf8'), offsetMs);
      if (parsed.lines.length === 0) { throw new Error(`歌词为空：${lrcPath}`); }
      lines = parsed.lines;
      lyricFrom = `${lrcPath}（${lines.length} 行${parsed.meta.ti ? ` · ${parsed.meta.ti}` : ''}）`;
    } else if (o.noFetch) {
      // 用户明确关掉联网，保留旧行为：没文件就报错，别偷偷发网络请求
      throw new Error('没有歌词文件（同名 .lrc 也没有），且指定了 --no-fetch。请提供 .lrc。');
    } else {
      const { title, artist } = parseTrackName(basename(audioPath, extname(audioPath)));
      const durationSec = await probeDurationSec(audioPath);
      const found = await fetchLyrics(
        { title, artist, durationSec },
        { sources: o.source ? [o.source as LyricSourceId] : undefined,
          onLog: (m) => console.log(multi ? `${tag}${m.trim()}` : m) },
      );
      if (!found) {
        throw new Error(`没找到「${title}」的歌词。可以自己给一份 .lrc 放到音频旁边，或换 --source 再试。`);
      }
      // fetch.ts 的 toRenderLines 已经在每行补上了 text，但 FetchLyricsResult.lines 声明的是
      // 上游那份没有 text 的 Line —— 断言补回本项目的 Line（字段与运行时一致，只是类型丢了）。
      lines = found.lines as Line[];
      lyricFrom = `${found.source}（${found.songName} - ${found.artist}，${found.isWordByWord ? '逐字' : '仅行级'}）`;
    }

    console.log(multi ? `${tag}歌词 ${lyricFrom}` : `歌词    ${lyricFrom}`
      + (lrcPath && offsetMs ? `\n偏移    ${offsetMs > 0 ? '+' : ''}${offsetMs} ms（正值＝歌词提前）` : ''));

    let audioForRender = audioPath;
    let linesForRender = lines;
    let tmpAudio: string | null = null;
    if (startSec > 0 || clipSec > 0) {
      tmpAudio = join(tmpdir(), `folia-clip-${process.pid}-${Date.now()}-${index}.wav`);
      const a: string[] = ['-v', 'error', '-y'];
      if (startSec > 0) { a.push('-ss', String(startSec)); }
      a.push('-i', audioPath);
      if (clipSec > 0) { a.push('-t', String(clipSec)); }
      a.push('-c:a', 'pcm_s16le', tmpAudio);
      if ((await Bun.spawn([await resolveFfmpeg(), ...a]).exited) !== 0) {
        throw new Error('截取音频片段失败');
      }
      audioForRender = tmpAudio;
      // 歌词的时间轴跟着平移；完全落在片段外的行丢掉，否则渲染器会一直等它们。
      const shift = (v: number): number => v - startSec;
      linesForRender = lines
        .map((l) => ({ ...l, startTime: shift(l.startTime), endTime: shift(l.endTime),
                       words: l.words.map((w) => ({ ...w, startTime: shift(w.startTime), endTime: shift(w.endTime) })) }))
        .filter((l) => l.endTime > 0 && (clipSec <= 0 || l.startTime < clipSec));
      console.log(`${tag}片段    ${startSec}s 起${clipSec ? ` ${clipSec}s` : ''}（${linesForRender.length} 行歌词）`);
    }

    const fmtDur = (sec: number) => `${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, '0')}`;
    const t0 = Date.now();
    let encodeT0 = 0;                       // 合成阶段的起点，用来单独估它的剩余时间
    let lastLine = '';
    const drawProgress = (p: number, etaSec: number | null) => {
      if (multi) { return; }
      const bar = '█'.repeat(Math.floor(p * 24)).padEnd(24, '░');
      const pct = String(Math.round(p * 100)).padStart(3);
      const line = `  ${bar} ${pct}%  已用时 ${fmtDur((Date.now() - t0) / 1000)}`
        + (etaSec != null ? `  剩余 ${fmtDur(Math.max(0, etaSec))}` : '');
      if (line !== lastLine) { process.stdout.write(`\r${line}`); lastLine = line; }
    };
    // 多首并行时没有「同一行原地刷新」可用 —— 用带前缀的日志，每 10% 打一条
    let lastPct = -1; let lastStage = '';
    const report = (stage: string, p: number) => {
      if (!multi) { return; }
      const step = Math.floor(p * 10);
      if (step === lastPct && stage === lastStage) { return; }
      lastPct = step; lastStage = stage;
      console.log(`${tag}${stage} ${String(Math.round(p * 100)).padStart(3)}%`);
    };

    try {
      const r = await renderToMp4({
        audioPath: audioForRender, lines: linesForRender, output, siteDir,
        // 片段渲染时 audioForRender 是临时文件，封面要回原始音频的目录找
        coverFrom: audioPath, cover: o.cover ?? null,
        render: {
          width: outW, height: outH, fps: outFps, mode, background,
          // 只覆盖动画强度，其余颜色让渲染器用出厂值补齐（见 stitch.ts 的 theme 合并）
          theme: { animationIntensity: intensity },
          crf: num(o.crf, 16),
        },
        onStage: (s, d) => {
          if (multi) { console.log(`${tag}${d}`); return; }
          // 进度条用 \r 原地刷新，不先换行的话这一行会被盖在它上面看不见
          if (lastLine) { process.stdout.write('\n'); lastLine = ''; }
          console.log(`[${s}] ${d}`);
        },
        onProgress: (p) => {
          if (multi) { report('渲染帧', p); return; }
          const el = (Date.now() - t0) / 1000;
          // 进度太小时除以 p 会把剩余时间放大得离谱，先不显示
          drawProgress(p, p > 0.02 ? (el * (1 - p)) / p : null);
        },
        // 合成阶段重开一条进度：它和渲染帧是两段独立的耗时，不能共用同一个起点
        onEncodeProgress: (p) => {
          if (multi) { report('合成', p); return; }
          if (!encodeT0) { encodeT0 = Date.now(); }
          const el = (Date.now() - encodeT0) / 1000;
          drawProgress(p, p > 0.02 ? (el * (1 - p)) / p : null);
        },
        onFfmpegProgress: (p) => {
          if (multi) { report('释放 ffmpeg', p); } else { drawProgress(p, null); }
        },
      });
      if (multi) {
        console.log(`${tag}✓ ${r.output}  ${r.renderFps.toFixed(1)} fps  ${r.seconds.toFixed(1)}s`);
      } else {
        console.log('\n');
        console.log(`✓ ${r.output}`);
        console.log(`  ${r.frames} 帧 / ${r.durationSec.toFixed(1)}s 视频`);
        console.log(`  渲染 ${r.renderFps.toFixed(1)} fps，总耗时 ${r.seconds.toFixed(1)}s`);
      }
    } finally {
      if (tmpAudio) { rmSync(tmpAudio, { force: true }); }
    }
  };

  const settled = await runPool(audios, multi ? jobsLimit : 1, (audio, i) => renderOne(audio, i));
  const failures = settled
    .map((r, i) => (r.status === 'rejected' ? { audio: audios[i], reason: r.reason } : null))
    .filter((x): x is { audio: string; reason: unknown } => x !== null);

  if (multi) {
    console.log(`\n完成：成功 ${audios.length - failures.length} 首，失败 ${failures.length} 首`);
    for (const f of failures) {
      console.error(`  ${basename(f.audio)}：${f.reason instanceof Error ? f.reason.message : String(f.reason)}`);
    }
  } else if (failures.length > 0) {
    const reason = failures[0].reason;
    console.error(`\n渲染失败：${reason instanceof Error ? reason.message : String(reason)}`);
  }
  return failures.length > 0 ? 2 : 0;
}

function printHelp(): void {
  console.log(`folia-video —— 把 Folia 歌词页渲染成 mp4

用法
  folia-video <音频> [歌词.lrc] [选项]
  folia-video <音频1> <音频2> ... [--jobs 3] [选项]   多首并行（各自配同名 .lrc 或联网取词）

选项
  --out <路径>        输出 mp4（默认与音频同名；只能用于单首）
  --width/--height    分辨率（默认 1920x1080）
  --fps               帧率（默认 60）
  --mode <名称>       视觉效果（默认 classic）
  --intensity <名称>  动画强度 normal|chaotic|calm（默认 normal）
  --background <名称> 背景（默认 latent）
  --offset <毫秒>     歌词整体偏移，正值＝歌词提前（默认 0）
  --start <秒>        只渲染从第几秒开始的片段（默认 0）
  --duration <秒>     片段长度（默认整首）
  --cover <图片>      封面图（莫奈等模式右侧的肖像）。默认自动找与音频同名的图片
  --crf <数值>        H.264 质量，越小越好（默认 16）
  --jobs <数量>       同时渲染几首（1..6，默认 3）
  --site <目录>       bundle 所在目录（默认内置）
  --source <源>       歌词源 qq|kugou|amll（默认依次试）
  --no-fetch          找不到歌词文件时不要联网搜，直接报错

歌词
  不传 .lrc 时，先找与音频同名的 .lrc；没有就联网搜（--no-fetch 可关掉）。`);
}

if (import.meta.main) {
  process.exit(await main());
}
