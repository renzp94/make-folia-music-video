// 终端界面：选音频 / 歌词 / 视觉效果 / 背景 / 动画强度 / 清晰度，然后交给 renderToMp4。
//
// 模式与背景的中文标签照抄 echo-folia-plugin/index.js 的 MODE_LABELS /
// BACKGROUND_LABELS / ANIMATION_LABELS。插件那边也是硬编码的 —— Folia 的 bundle
// 只导出 listPanelModes / listBackgroundModes，给的是英文 fallback。与其为了几个
// 标签去改 folia-major 再重建 bundle，不如两边各存一份，改的时候一起改。
import React, { useState, useRef, useEffect } from 'react';
import { render, Box, Text, useInput, useApp } from 'ink';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import {
  renderToMp4, systemFfmpeg, ffmpegVersion, EMBEDDED_FFMPEG_VERSION,
  FfmpegUnavailableError, type FfmpegPreference,
} from './render.ts';
import { parseLrc } from './lrc.ts';
import { loadConfig, saveConfig, CONFIG_PATH } from './config.ts';
import { basename, extname, join, resolve, dirname } from 'node:path';

const AUDIO_EXT = new Set(['.mp3', '.flac', '.wav', '.m4a', '.aac', '.ogg', '.opus']);
const LRC_EXT = new Set(['.lrc']);

// 标签数据的定义搬到了 ./labels.ts —— index.ts 也要用它，而从本文件取会把 ink 拖进 CLI 流程
import {
  MODE_LABELS, BACKGROUND_LABELS, INTENSITY_LABELS, FFMPEG_LABELS, QUALITIES, labelOf, type Pair,
} from './labels.ts';
export { MODE_LABELS, BACKGROUND_LABELS, INTENSITY_LABELS, FFMPEG_LABELS, QUALITIES, labelOf };
export type { Pair } from './labels.ts';

/** 界面选定的渲染任务。 */
export type Job = {
  audio: string; lrc: string;
  width: number; height: number;
  mode: string; background: string; intensity: string;
};

/** 渲染任务在界面里的实时状态。 */
type RunState = {
  running: boolean;
  /** 0..1，渲染帧阶段和合成阶段各自从 0 走到 1。 */
  progress: number;
  label: string;          // 阶段名：准备中 / 渲染帧 / 合成
  detail: string;         // 具体信息（帧数 / 输出路径 / 错误）
  ok: boolean;            // 结束时是否成功
};

type Option = {
  key: string; label: string;
  /** 覆盖显示颜色（目录用蓝、上级用灰）。 */
  color?: string;
  /** 该条目是否是当前取值（子列表里打勾）。 */
  current?: boolean;
};

const listFiles = (dir: string, exts: Set<string>): string[] => {
  try {
    return readdirSync(dir)
      .filter((n) => !n.startsWith('.') && exts.has(extname(n).toLowerCase()))
      .filter((n) => { try { return statSync(join(dir, n)).isFile(); } catch { return false; } })
      .sort();
  } catch { return []; }
};

/** 列目录：子目录（总是列出）与匹配后缀的文件分开，供选择器分级呈现。 */
const listDir = (dir: string, exts: Set<string>): { dirs: string[]; files: string[] } => {
  const dirs: string[] = [], files: string[] = [];
  try {
    for (const n of readdirSync(dir)) {
      if (n.startsWith('.')) continue;
      try {
        if (statSync(join(dir, n)).isDirectory()) dirs.push(n);
        else if (exts.has(extname(n).toLowerCase())) files.push(n);
      } catch { /* 读不到的项跳过 */ }
    }
  } catch { /* 目录不可读时当空处理 */ }
  return { dirs: dirs.sort(), files: files.sort() };
};

/** 与音频同名的 .lrc（忽略大小写与空格差异）。 */
export const guessLrc = (audio: string): string | null => {
  const dir = dirname(audio);
  const norm = (s: string) => s.replace(/[\s　]/g, '').toLowerCase();
  const stem = norm(basename(audio, extname(audio)));
  return listFiles(dir, LRC_EXT).map((n) => join(dir, n)).find((p) => norm(basename(p, '.lrc')) === stem) ?? null;
};

/** 一个居中的方框，用来做启动确认和异常提示 —— 需要用户明确表态，不能默默替它决定。 */
const Dialog: React.FC<{ title: string; children: React.ReactNode; hint: string }> =
  ({ title, children, hint }) => (
    <Box flexDirection="column" paddingLeft={1} paddingTop={1}>
      <Box borderStyle="round" borderColor="yellow" flexDirection="column" paddingX={2} paddingY={1} width={72}>
        <Text bold color="yellow">{title}</Text>
        <Text> </Text>
        {children}
        <Text> </Text>
        <Text dimColor>{hint}</Text>
      </Box>
    </Box>
  );

const fmtDur = (sec: number) => `${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, '0')}`;

/** 按钮下方的进度区：进度条 + 已用时 / 剩余 + 阶段信息。 */
const RunPanel: React.FC<{ run: RunState; startedAt: number; width: number }> = ({ run, startedAt, width }) => {
  const elapsed = (Date.now() - startedAt) / 1000;
  // 进度太小时除以 p 会把剩余时间放大得离谱，先不显示
  const eta = run.running && run.progress > 0.02 ? (elapsed * (1 - run.progress)) / run.progress : null;
  const barW = Math.max(12, Math.min(40, width - 34));
  const filled = Math.round(barW * run.progress);
  const bar = '█'.repeat(filled) + '░'.repeat(barW - filled);
  const tint = run.running ? 'yellow' : run.ok ? 'green' : 'red';
  return (
    <Box flexDirection="column" marginTop={1} paddingLeft={2}>
      <Text>
        <Text color={tint}>{bar}</Text>
        <Text color={tint}>{`  ${String(Math.round(run.progress * 100)).padStart(3)}%`}</Text>
        <Text dimColor>{`  ${run.label}`}</Text>
      </Text>
      {/* 阶段信息（「1 路并行」「240 帧 / 4.0 秒」之类）就接在时间后面，省一行 */}
      <Text dimColor>
        {run.running
          ? `已用时 ${fmtDur(elapsed)}`
            + (eta != null ? `   剩余 ${fmtDur(Math.max(0, eta))}` : '')
            + (run.detail ? `   ${run.detail}` : '')
          : run.detail}
      </Text>
    </Box>
  );
};

const List: React.FC<{
  title: string; hint: string; items: Option[]; cursor: number; empty: string;
}> = ({ title, hint, items, cursor, empty }) => (
  <Box flexDirection="column">
    <Text dimColor>{title}</Text>
    {items.length === 0
      ? <Text dimColor>  {empty}</Text>
      : items.map((it, i) => {
        const active = i === cursor;
        return (
          <Text key={it.key} inverse={active}>
            {active ? '❯ ' : '  '}
            {/* 当前取值用亮色标出，而不是加 ✔ —— 选项一列排开时符号反而碍眼 */}
            <Text color={active ? undefined : it.current ? 'cyan' : it.color}
                  bold={!active && it.current}>{it.label}</Text>
          </Text>
        );
      })}
    <Text dimColor>{hint}</Text>
  </Box>
);

type View = 'main' | 'pickAudio' | 'pickLrc' | 'mode' | 'background' | 'intensity' | 'quality' | 'settings';

type State = {
  audio: string | null; lrc: string | null;
  mode: string; background: string; intensity: string; quality: string;
};

/** 主菜单里能用 ←→ 直接循环切换取值的字段（音频/歌词不在内，那两个必须走文件选择）。 */
type SwitchField = 'mode' | 'background' | 'intensity' | 'quality';
const SWITCH_FIELDS: Record<SwitchField, readonly Pair[]> = {
  mode: MODE_LABELS,
  background: BACKGROUND_LABELS,
  intensity: INTENSITY_LABELS,
  quality: QUALITIES.map((q) => [q[0], q[0]] as const),
};

const App: React.FC<{ startDir: string; onDone: (job: Job | null) => void }> = ({ startDir, onDone }) => {
  const { exit } = useApp();
  const [state, setState] = useState({
    audio: null as string | null, lrc: null as string | null, mode: 'classic',
    background: 'latent', intensity: 'normal', quality: '1080p',
  });
  const [view, setView] = useState<View>('main');
  const [cursor, setCursor] = useState(0);
  const [dir, setDir] = useState(resolve(startDir));
  const [error, setError] = useState('');

  // useInput 的回调只在渲染时刷新，而 React 会把同一批事件里的多次 setState 合并成一次
  // 渲染 —— 回调里读 state/cursor 会拿到合并前的旧值（按 ↓↓ 再回车，进的是第一项而不是
  // 第二项）。用 ref 镜像一份，回调与 enter() 里一律读 live.current。
  // ffmpeg 来源：null = 还没定（要弹窗问），否则是用户选定/自动决定的
  // null = 还没定过（要弹窗问）。读到了配置就直接用 —— 这是「记住选择」的实现点。
  const [ffmpegPref, setFfmpegPref] = useState<FfmpegPreference | null>(() => {
    const saved = loadConfig().ffmpeg;
    if (saved) return saved;
    // 机器上没有 ffmpeg 时没什么可问的，直接用内置的、不问也不存（换机器还能重来）
    return systemFfmpeg() ? null : 'embedded';
  });
  // 用户选了系统那份、但实际调用失败时，把原因记下来再问一次
  const [ffmpegFallback, setFfmpegFallback] = useState<string | null>(null);
  const sysFfmpeg = useRef(systemFfmpeg()).current;
  // 系统那份的版本要 spawn 一次才知道；查不到就显示 null（存在但坏了，本身也是个信号）
  const [sysVersion, setSysVersion] = useState<string | null | undefined>(undefined);
  useEffect(() => {
    if (!sysFfmpeg) return;
    let alive = true;
    void ffmpegVersion(sysFfmpeg).then((v) => { if (alive) setSysVersion(v); });
    return () => { alive = false; };
  }, [sysFfmpeg]);
  // 只给文字，括号由调用处加 —— 否则「用电脑上的（（查询中…））」会套两层
  const verText = (v: string | null | undefined) =>
    v === undefined ? '查询中…' : v === null ? '无法获取版本' : `v${v}`;
  const [ffmpegCursor, setFfmpegCursor] = useState(0);
  // 退出要二次确认 —— 一次手滑按到 q，刚选好的一整套参数就白填了
  const [confirmExit, setConfirmExit] = useState(false);

  const live = useRef({ state, view, cursor, ffmpegPref });
  live.current = { state, view, cursor, ffmpegPref };

  const [run, setRun] = useState<RunState | null>(null);
  const [startedAt, setStartedAt] = useState(0);
  const abortRef = useRef<AbortController | null>(null);

  /**
   * @param prefOverride 刚在弹窗里改了偏好时显式传进来 —— setState 是异步的，
   *   此时 live.current 还是旧值，不传就会退回 auto，而那正是刚失败的那份，
   *   于是「改用内置的」会变成无限重试同一个错误。
   */
  const startRender = (prefOverride?: FfmpegPreference) => {
    const s = live.current.state;
    const lrc = s.lrc ?? (s.audio ? guessLrc(s.audio) : null);
    if (!s.audio) { setError('还没有选择音频文件'); return; }
    if (!lrc) { setError('还没有选择歌词文件（也没找到同名 .lrc）'); return; }

    let lines;
    try {
      lines = parseLrc(readFileSync(lrc, 'utf8'), 0).lines;
    } catch (e) {
      setError(`歌词读不出来：${(e as Error).message}`);
      return;
    }
    if (lines.length === 0) { setError(`歌词是空的：${lrc}`); return; }

    const q = QUALITIES.find(([k]) => k === s.quality) ?? QUALITIES[1];
    const output = join(dirname(s.audio), `${basename(s.audio, extname(s.audio))}.mp4`);
    const ac = new AbortController();
    abortRef.current = ac;
    setError('');
    setStartedAt(Date.now());
    setRun({ running: true, progress: 0, label: '准备中', detail: '', ok: false });

    renderToMp4({
      audioPath: s.audio, lines, output,
      ffmpeg: prefOverride ?? live.current.ffmpegPref ?? 'auto',
      coverFrom: s.audio,
      // 空路径必然 existsSync 失败，于是 serveStatic 落到内嵌的那份资源（见 src/assets.ts）
      siteDir: '',
      signal: ac.signal,
      render: {
        width: q[1], height: q[2], fps: 60, mode: s.mode, background: s.background,
        theme: { animationIntensity: s.intensity },
      },
      onStage: (_stage, detail) => setRun((r) => r && { ...r, detail }),
      // 释放内置 ffmpeg 时进度条复用同一个面板，标签写清楚是在干什么
      onFfmpegProgress: (p) => setRun((r) => r && { ...r, progress: p, label: '释放内置 ffmpeg' }),
      onProgress: (p) => setRun((r) => r && { ...r, progress: p, label: '渲染帧' }),
      onEncodeProgress: (p) => setRun((r) => r && { ...r, progress: p, label: '合成' }),
    }).then((res) => {
      setRun({
        running: false, progress: 1, label: '完成', ok: true,
        detail: `${res.frames} 帧 / ${res.durationSec.toFixed(1)}s  →  ${res.output}`,
      });
    }).catch((e: unknown) => {
      const aborted = ac.signal.aborted;
      setRun(null);
      // 用户选了系统那份 ffmpeg 却用不了 → 说明原因，问要不要改用内置的
      if (!aborted && e instanceof FfmpegUnavailableError) {
        setFfmpegFallback((e as Error).message);
        return;
      }
      setRun({
        running: false, progress: 0, ok: false,
        label: aborted ? '已取消' : '失败',
        detail: aborted ? '' : String((e as Error)?.message ?? e),
      });
    }).finally(() => { abortRef.current = null; });
  };

  const autoLrc = state.audio && !state.lrc ? guessLrc(state.audio) : null;

  // group 只写在每组第一项上，渲染时插一行小标题
  const menu = [
    { key: 'audio', group: '输入', label: '音频文件', value: state.audio ? basename(state.audio) : '(未选择)', to: 'pickAudio' as View },
    { key: 'lrc', label: '歌词文件', value: state.lrc ? basename(state.lrc) : (autoLrc ? `自动配对 ${basename(autoLrc)}` : '(未选择)'), to: 'pickLrc' as View },
    { key: 'mode', group: '效果', label: '视觉效果', value: `${labelOf(MODE_LABELS, state.mode)} (${state.mode})`, to: 'mode' as View },
    { key: 'background', label: '背景效果', value: labelOf(BACKGROUND_LABELS, state.background), to: 'background' as View },
    { key: 'intensity', label: '动画强度', value: labelOf(INTENSITY_LABELS, state.intensity), to: 'intensity' as View },
    { key: 'quality', group: '输出', label: '清晰度', value: state.quality, to: 'quality' as View },
    { key: 'settings', group: '其他', label: '设置', value: ffmpegPref ? labelOf(FFMPEG_LABELS, ffmpegPref) : '待选择', to: 'settings' as View },
    { key: 'run', label: '', value: '', to: 'main' as View },
  ];

  const options = (v: View): Option[] => {
    switch (v) {
      case 'pickAudio':
      case 'pickLrc': {
        const { dirs, files } = listDir(dir, v === 'pickAudio' ? AUDIO_EXT : LRC_EXT);
        const parent = dirname(dir);
        const chosen = v === 'pickAudio' ? live.current.state.audio : live.current.state.lrc;
        return [
          ...(parent !== dir ? [{ key: '..', label: '..（上级目录）', color: 'gray' }] : []),
          ...dirs.map((n) => ({ key: `dir:${n}`, label: `${n}/`, color: 'blue' })),
          ...files.map((n) => ({ key: join(dir, n), label: n, current: join(dir, n) === chosen })),
        ];
      }
      case 'mode': return MODE_LABELS.map(([k, l]) => ({ key: k, label: `${l} (${k})`, current: k === live.current.state.mode }));
      case 'background': return BACKGROUND_LABELS.map(([k, l]) => ({ key: k, label: `${l} (${k})`, current: k === live.current.state.background }));
      case 'intensity': return INTENSITY_LABELS.map(([k, l]) => ({ key: k, label: `${l} (${k})`, current: k === live.current.state.intensity }));
      case 'quality': return QUALITIES.map(([k, w, h]) => ({ key: k, label: `${k}  ${w}×${h}`, current: k === live.current.state.quality }));
      case 'settings': return [
        { key: 'auto', label: `自动（有电脑上的就用它）`, current: ffmpegPref === 'auto' },
        { key: 'system', label: `用电脑上的${sysFfmpeg ? `  ${sysFfmpeg}` : '（未检测到）'}`, current: ffmpegPref === 'system' },
        { key: 'embedded', label: `用内置的  v${EMBEDDED_FFMPEG_VERSION}`, current: ffmpegPref === 'embedded' },
      ];
      default: return [];
    }
  };

  const items: Option[] = view === 'main'
    ? menu.map((m) => ({ key: m.key, label: `${m.label.padEnd(10)} ${m.value}` }))
    : options(view);

  const enter = () => {
    const { state: s, view: v, cursor: c } = live.current;

    if (v === 'main') {
      const target = menu[c].to;
      if (target === 'main') {                       // 「开始渲染」按钮
        if (run?.running) { abortRef.current?.abort(); return; }
        startRender();
        return;
      }
      setView(target);
      // 每一项都带 current，直接找它 —— 比按字段名反查通用，设置页也能自动定位到当前选择
      setCursor(Math.max(0, options(target).findIndex((o) => o.current)));
      setError('');
      return;
    }
    const picked = options(v)[c];
    if (!picked) return;
    // 目录项只换目录、留在选择视图里，不当作「选中了一个文件」
    if (picked.key === '..') { setDir(dirname(dir)); setCursor(0); return; }
    if (picked.key.startsWith('dir:')) { setDir(join(dir, picked.key.slice(4))); setCursor(0); return; }
    // 设置页的值不落在 state 里（它有自己的 state），所以单独处理、不进下面的 patch 表
    if (v === 'settings') {
      const choice = picked.key as FfmpegPreference;
      setFfmpegPref(choice);
      saveConfig({ ffmpeg: choice });          // 记住，下次启动不再问
      setView('main');
      setCursor(0);
      return;
    }
    const patch: Partial<typeof state> = {
      pickAudio: { audio: picked.key }, pickLrc: { lrc: picked.key },
      mode: { mode: picked.key }, background: { background: picked.key },
      intensity: { intensity: picked.key }, quality: { quality: picked.key },
    }[v] as Partial<typeof state>;
    setState((s) => ({ ...s, ...patch }));
    setView('main');
    setCursor(0);
  };

  useInput((input, key) => {
    const { view: v, cursor: c } = live.current;

    // 退出确认盖在所有界面之上 —— 它是「你要退出吗」那一问，不该被任何弹窗挡在后面。
    // Ctrl-C 也算反悔：否则它就成了绕过二次确认的后门。
    if (confirmExit) {
      if (key.return || input === 'y') { exit(); onDone(null); return; }
      setConfirmExit(false);
      return;
    }

    // 弹窗优先吃掉按键：这两个都是「必须表态」的，不能在背后操作别的
    const dialogOpen = (ffmpegPref === null && sysFfmpeg) || Boolean(ffmpegFallback);
    if (dialogOpen) {
      // 弹窗会吃掉所有按键，退出键必须自己处理 —— 否则整个程序卡在这里退不出去
      if ((key.ctrl && input === 'c') || input === 'q') { setConfirmExit(true); return; }
      const n = 2;
      if (key.upArrow || input === 'k') setFfmpegCursor((x) => (x - 1 + n) % n);
      if (key.downArrow || input === 'j') setFfmpegCursor((x) => (x + 1) % n);
      if (key.return) {
        if (ffmpegFallback) {
          // 兜底窗：0 = 改用内置的并重试，1 = 取消
          const useEmbedded = ffmpegCursor === 0;
          setFfmpegFallback(null);
          setFfmpegCursor(0);
          if (useEmbedded) { setFfmpegPref('embedded'); startRender('embedded'); }
        } else {
          const choice: FfmpegPreference = ffmpegCursor === 0 ? 'system' : 'embedded';
          setFfmpegPref(choice);
          saveConfig({ ffmpeg: choice });        // 记住，下次不再问
          setFfmpegCursor(0);
        }
      }
      return;
    }
    // 渲染进行中：只认「停止」，别让误触改了配置（改也影响不了已经在跑的任务）
    if (run?.running) {
      if (key.ctrl && input === 'c') { abortRef.current?.abort(); return; }
      if (key.return || input === 's') { abortRef.current?.abort(); return; }
      return;
    }
    if (key.ctrl && input === 'c') { setConfirmExit(true); return; }
    if (v === 'main' && input === 'q') { setConfirmExit(true); return; }
    if (key.escape) { setView('main'); setCursor(0); setError(''); return; }
    // s 是进入设置页的快捷方式，和主菜单 Enter 走同一个落点（定位到当前选择）
    if (v === 'main' && input === 's') {
      setView('settings');
      setCursor(Math.max(0, options('settings').findIndex((o) => o.current)));
      setError('');
      return;
    }
    // 主菜单里的「视觉效果 / 背景 / 动画强度 / 清晰度」用 ←→ 直接循环切换取值，
    // 不必进子列表（音频/歌词两项除外 —— 那些必须走文件选择）。
    if (v === 'main' && (key.leftArrow || key.rightArrow)) {
      const field = SWITCH_FIELDS[menu[c].key as SwitchField];
      if (field) {
        const cur = String(live.current.state[menu[c].key as SwitchField]);
        const i = field.findIndex(([k]) => k === cur);
        const n = field.length;
        const next = field[((i + (key.rightArrow ? 1 : -1)) % n + n) % n][0];
        setState((prev) => ({ ...prev, [menu[c].key]: next }) as State);
        setError('');
      }
      return;
    }
    if (key.upArrow || input === 'k') setCursor((x) => (x - 1 + items.length) % items.length);
    if (key.downArrow || input === 'j') setCursor((x) => (x + 1) % items.length);
    if (key.return) enter();
  });

  // 注意用 || 不是 ?? —— 非交互终端下 columns 是 0（不是 undefined），?? 兜不住
  const W = Math.min(process.stdout.columns || 76, 76);
  const rule = '─'.repeat(Math.max(10, W - 4));

  // ── 退出确认：盖在所有界面之上，包括 ffmpeg 弹窗 ────────────────────────────
  if (confirmExit) {
    return (
      <Dialog title="确认退出" hint="Enter 或 y 退出   Esc 取消">
        <Text>确定要退出吗？</Text>
      </Dialog>
    );
  }

  // ── 启动确认：装了 ffmpeg 的机器上问一句用哪份 ──────────────────────────────
  if (ffmpegPref === null && sysFfmpeg) {
    const opts = [
      [`用电脑上的（${verText(sysVersion)}）`, '不占额外磁盘；版本由你维护，通常也更新'],
      [`用内置的（v${EMBEDDED_FFMPEG_VERSION}）`, '首次使用时释放到临时目录，占约 43 MB'],
    ];
    return (
      <Dialog title="选择 ffmpeg" hint="↑↓/jk 选择   Enter 确认   q 退出">
        <Text bold>为什么要用 ffmpeg？</Text>
        <Text dimColor>渲染有三步离不开它：把音频解码成波形来算频谱、</Text>
        <Text dimColor>读取并缩放封面图、把逐帧画面和音频合成为 MP4。</Text>
        <Text> </Text>
        <Text>检测到电脑上已安装：</Text>
        <Text color="cyan">{sysFfmpeg}  <Text dimColor>（{verText(sysVersion)}）</Text></Text>
        <Text> </Text>
        <Text>本程序也内置了一份（约 43 MB）：</Text>
        <Text color="cyan">v{EMBEDDED_FFMPEG_VERSION}</Text>
        <Text> </Text>
        <Text>用哪一份？</Text>
        <Text> </Text>
        {opts.map(([label, note], i) => (
          <Box key={label} flexDirection="column">
            <Text inverse={i === ffmpegCursor}>
              {i === ffmpegCursor ? '❯ ' : '  '}<Text bold={i === ffmpegCursor}>{label}</Text>
            </Text>
            <Text dimColor>{`    ${note}`}</Text>
          </Box>
        ))}
      </Dialog>
    );
  }

  // ── 兜底：选了系统那份、实际却用不了 ────────────────────────────────────────
  if (ffmpegFallback) {
    const opts = [['改用内置的并重试', '不需要你做别的，直接换一份继续'], ['取消', '保持现状，什么也不做']];
    return (
      <Dialog title="电脑上的 ffmpeg 用不了" hint="↑↓/jk 选择   Enter 确认   q 退出">
        <Text bold>为什么要用 ffmpeg？</Text>
        <Text dimColor>解码音频算频谱、处理封面、合成 MP4 —— 这三步都靠它，缺了跑不下去。</Text>
        <Text> </Text>
        <Text>你选择了使用<Text bold>电脑上的 ffmpeg</Text>，但实际调用时失败了：</Text>
        <Text color="red">{ffmpegFallback}</Text>
        <Text> </Text>
        <Text>常见原因：它被移动或删除了，或者不在当前终端的 PATH 里。</Text>
        <Text> </Text>
        <Text>要改用<Text bold>程序内置的那份</Text>（约 43 MB）重新渲染吗？</Text>
        <Text> </Text>
        {opts.map(([label, note], i) => (
          <Box key={label} flexDirection="column">
            <Text inverse={i === ffmpegCursor}>
              {i === ffmpegCursor ? '❯ ' : '  '}<Text bold={i === ffmpegCursor}>{label}</Text>
            </Text>
            <Text dimColor>{`    ${note}`}</Text>
          </Box>
        ))}
      </Dialog>
    );
  }
  // 渲染中除停止键以外的按键都被吃掉（见 useInput 的 run.running 分支），
  // 底部提示必须跟着变，否则还写着「q 退出」但按了没反应
  const hint = run?.running
    ? 'Enter / s / Ctrl-C 停止渲染'
    : view === 'main'
      ? '↑↓/jk 选择   ←→ 切换   Enter 确认   s 设置   q 退出'
      : '↑↓/jk 选择   Enter 确认   Esc 返回';

  return (
    <Box flexDirection="column" paddingLeft={1} paddingTop={1}>
      <Box flexDirection="column" borderStyle="round" borderColor="cyan" width={W} paddingX={1}>
        <Box justifyContent="space-between">
          <Text bold color="cyan">Folia 视频渲染</Text>
          <Text dimColor>将音乐歌词渲染成 Folia 视觉效果视频</Text>
        </Box>
        <Text dimColor>{rule}</Text>
        <Box flexDirection="column" marginTop={1}>
          {view === 'main'
            ? menu.map((m, i) => {
              const active = i === cursor;
              const unset = !m.value || m.value.startsWith('(');
              // 「开始渲染」显示成一条动作，而不是「标签 + 值」
              if (m.key === 'run') {
                const busy = run?.running ?? false;
                // 按钮：未选中是幽灵按钮，选中变实心；渲染中变红并改成「停止」
                const bg = busy ? 'red' : active ? 'cyan' : undefined;
                const fg = busy || active ? 'black' : 'cyan';
                const text = busy ? '   ■  停止渲染   ' : '  ▶  开始渲染   ';
                return (
                  <Box key={m.key} flexDirection="column" marginTop={1}>
                    <Box>
                      <Text>  </Text>
                      <Text bold backgroundColor={bg} color={fg}>{text}</Text>
                    </Box>
                    {run ? <RunPanel run={run} startedAt={startedAt} width={W} /> : null}
                  </Box>
                );
              }
              return (
                <Box key={m.key} flexDirection="column">
                  {m.group ? <Text dimColor>{m.group}</Text> : null}
                  <Text inverse={active}>
                    {active ? '❯ ' : '  '}
                    <Text bold={active}>{m.label.padEnd(10)}</Text>
                    <Text color={active ? undefined : unset ? 'gray' : 'green'}>{m.value}</Text>
                  </Text>
                </Box>
              );
            })
            : <List title={dir} hint="" items={items} cursor={cursor} empty="(此目录没有可选文件)" />}
        </Box>
        <Box marginTop={1}><Text dimColor>{rule}</Text></Box>
        {error ? <Text color="red">{error}</Text> : <Text dimColor>{hint}</Text>}
      </Box>
    </Box>
  );
};

/**
 * 跑界面，返回用户选定的任务；用户取消时返回 null。
 * 界面退出后才真正开始渲染 —— 渲染日志要占满终端，不能和 ink 抢屏幕。
 */
export const runTui = ({ startDir = process.cwd() }: { startDir?: string } = {}): Promise<Job | null> =>
  new Promise((res) => {
    let result: Job | null = null;
    // exitOnCtrlC 默认 true，会把 Ctrl-C 直接吃掉（ink 内部的 use-input 里就 return 了），
    // 于是取消渲染的处理函数永远收不到这个键。关掉它，由 App 自己决定 Ctrl-C 的含义：
    // 渲染中＝取消，空闲＝退出。
    const app = render(
      React.createElement(App, { startDir, onDone: (v: Job | null) => { result = v; } }),
      { exitOnCtrlC: false },
    );
    app.waitUntilExit().then(() => res(result)).catch(() => res(null));
  });
