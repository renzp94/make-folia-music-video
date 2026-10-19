// 模式 / 背景 / 动画强度的中文标签。
//
// 照抄 echo-folia-plugin/index.js 的 MODE_LABELS / BACKGROUND_LABELS / ANIMATION_LABELS。
// 插件那边也是硬编码的 —— Folia 的 bundle 只导出 listPanelModes / listBackgroundModes，
// 给的是英文 fallback。与其为了几个标签去改 folia-major 再重建 bundle，不如两边各存一份，
// 改的时候一起改。
//
// 单独成文件（而不是放在 tui.tsx 里）是因为 index.ts 也要用：tui.tsx 会 import ink，
// 从它那里取几个常量会把整个终端 UI 运行时拖进 CLI 流程。

export type Pair = readonly [key: string, label: string];

export const MODE_LABELS: readonly Pair[] = [
  ['classic', '流光'], ['partita', '云阶'], ['cadenza', '心象'], ['fume', '浮名'],
  ['monet', '莫奈'], ['cappella', '群唱'], ['tilt', '倾诉'], ['claddagh', '回环'],
  ['pendolo', '时计'], ['sonnet', '商籁'], ['tempera', '凝彩'], ['lumiere', '绘光'],
  ['diorama', '镜台'], ['still', '静止'],
];

export const BACKGROUND_LABELS: readonly Pair[] = [
  ['latent', '隐现'], ['common', '通用'], ['monet', '莫奈'],
  ['nomand', '漫游'], ['sora', '空'], ['url', '嵌入'],
];

export const INTENSITY_LABELS: readonly Pair[] = [
  ['normal', '标准'], ['chaotic', '混乱'], ['calm', '平静'],
];

export const FFMPEG_LABELS: readonly Pair[] = [
  ['auto', '自动'], ['system', '电脑上的'], ['embedded', '内置'],
];

/**
 * 联网取词用的歌词源。键与 `LyricSourceId` 对齐，外加一个 `auto`（依次试）。
 * 这里只存标签，不 import `lyrics/fetch.ts` —— Pair 是纯字符串表，没必要把
 * （会连带三个 provider 的）类型图拉进来。
 */
export const LYRIC_SOURCE_LABELS: readonly Pair[] = [
  ['auto', '自动'], ['kugou', '酷狗音乐'], ['qq', 'QQ 音乐'], ['amll', 'AMLL'],
];

/** [名称, 宽, 高] */
export const QUALITIES: ReadonlyArray<readonly [name: string, w: number, h: number]> = [
  ['720p', 1280, 720], ['1080p', 1920, 1080],
  ['2K', 2560, 1440], ['4K', 3840, 2160],
];

/** 查标签；查不到就原样返回 key（新加了模式而上游还没同步时至少不会显示空白）。 */
export const labelOf = (pairs: readonly Pair[], key: string): string =>
  (pairs.find(([k]) => k === key) ?? ['', key])[1];

/** 由分辨率反查档位名，用于渲染前展示「清晰度」。 */
export const qualityNameOf = (w: number, h: number): string =>
  QUALITIES.find(([, qw, qh]) => qw === w && qh === h)?.[0] ?? `${w}×${h}`;
