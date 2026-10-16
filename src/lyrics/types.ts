// 移植自 folia-major src/types.ts + src/types/onlineMusic.ts @ 7db1ad56
// 改动：只摘取歌词解析与歌曲元数据相关的类型；删掉了 UI 相关 import（lucide-react / framer-motion）
//      和 UnifiedSong（只有 neteaseProvider 用，本项目不涉及）。

// ===== 以下摘自 src/types.ts =====

export interface LyricRuby {
  text: string;
  startTime: number; // Seconds
  endTime: number; // Seconds
}

export interface LyricSyllable {
  text: string;
  startTime: number; // Seconds
  endTime: number; // Seconds
  endsWithSpace?: boolean;
  ruby?: LyricRuby[];
  obscene?: boolean;
  emptyBeat?: number;
}

export interface LyricAlternateText {
  role: 'translation' | 'romanization' | string;
  language?: string;
  text: string;
  syllables?: LyricSyllable[];
}

export interface Word {
  text: string;
  startTime: number; // Seconds
  endTime: number; // Seconds
  syllables?: LyricSyllable[];
}

export interface LyricBackgroundVocal {
  text: string;
  startTime: number; // Seconds
  endTime: number; // Seconds
  words: Word[];
  agentId?: string;
  translation?: string;
  romanization?: string;
  alternateTexts?: LyricAlternateText[];
}

export interface LyricAgent {
  id: string;
  name?: string;
  type?: string;
}

export interface Line {
  words: Word[];
  startTime: number;
  endTime: number;
  fullText: string;
  translation?: string;
  id?: string;
  agentId?: string;
  songPart?: string;
  blockIndex?: number;
  romanization?: string;
  alternateTexts?: LyricAlternateText[];
  backgroundVocal?: LyricBackgroundVocal;
  backgroundVocals?: LyricBackgroundVocal[];
  renderHints?: LineRenderHints;
  isChorus?: boolean;
  chorusEffect?: 'bars' | 'circles' | 'beams';
  // User-saved fine word boundaries for fullText, baked in upstream by the lyric setter.
  // join('') must equal fullText. When present it wins over every automatic segmentation.
  wordSegments?: string[];
  // icu-folia's automatic word boundaries for fullText (utils/lyrics/icuFolia), baked in by the
  // lyric setter once its engines have loaded. Used when there is no wordSegments; absent until
  // then, and the line falls back to plain Intl.Segmenter.
  autoWordSegments?: string[];
}

export interface LyricData {
  lines: Line[];
  title?: string;
  artist?: string;
  isWordByWord?: boolean;
  ttml?: {
    timingMode?: 'Word' | 'Line';
    agents?: Record<string, LyricAgent>;
  };
}

export interface Artist {
  id: MediaId;
  name: string;
  entityId?: string;
  catalogRef?: ProviderCatalogRef;
}

export interface Album {
  id: MediaId;
  name: string;
  coverUrl?: string;
  entityId?: string;
  catalogRef?: ProviderCatalogRef;
}

export interface SongPrivilege {
  id?: number;
  fee?: number;
  payed?: number;
  st?: number;
  pl?: number;
  dl?: number;
  flag?: number;
  cs?: boolean;
}

export interface NoCopyrightRecommendation {
  type?: number;
  typeDesc?: string;
  songId?: string | number;
  thirdPartySong?: unknown | null;
  expInfo?: unknown | null;
}

export type LyricProviderSource = 'netease' | 'qq' | 'kugou' | 'amll';
export type AmllDbPlatform = 'ncm' | 'qq';

export interface ReplayGainInfo {
  /** ReplayGain gain values in decibels. */
  trackGain?: number;
  albumGain?: number;
  /** ReplayGain peak values as positive linear ratios. */
  trackPeak?: number;
  albumPeak?: number;
}

export interface SongResult {
  id: MediaId;
  name: string;
  artists: Artist[];
  album: Album;
  durationMs: number;
  isPureMusic?: boolean;
  aliases?: string[];
  translatedNames?: string[];
  t?: 0 | 1 | 2;
  sourceType?: 'netease' | 'cloud';
  sourceRef?: PlaybackSourceRef;
  /** Identity of the concrete bytes selected for playback; used to reject stale derived media. */
  playbackSourceRevision?: string;
  fee?: number;
  noCopyrightRcmd?: NoCopyrightRecommendation | null;
  resourceState?: boolean;
  privilege?: SongPrivilege;
  onlineLyricsState?: OnlineLyricsState;
  matchedLyricsSource?: LyricProviderSource;
  matchedLyricsProviderPlatform?: AmllDbPlatform;
  replayGain?: ReplayGainInfo;
  qqMid?: string;
  kgHash?: string;
  amllDbPlatform?: AmllDbPlatform;
}

export interface OnlineLyricsState {
  lyricsSource: 'online' | 'imported';
  importedLyrics?: LyricData | null;
  importedLyricsName?: string | null;
  hasOnlineOverride?: boolean;
  onlineOverrideLyrics?: LyricData | null;
  matchedSongId?: MediaId;
  matchedIsPureMusic?: boolean;
  matchedLyricsSource?: LyricProviderSource;
  matchedLyricsProviderPlatform?: AmllDbPlatform;
}

// ===== 以下摘自 src/types/onlineMusic.ts =====

export type MediaId = string | number;
export type OnlineProviderId = 'netease' | (string & {});

export interface ProviderCatalogRef {
    providerId: OnlineProviderId;
    kind: ProviderCatalogEntityKind;
    id: MediaId;
}

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export type PlaybackSourceRef =
    | {
        kind: 'online';
        providerId: OnlineProviderId;
        mediaId: string;
        variant?: string;
        providerData?: Record<string, JsonValue>;
    }
    | { kind: 'local'; mediaId: string }
    | { kind: 'navidrome'; mediaId: string }
    | { kind: 'stage'; mediaId: string };

export interface ChorusRange {
    startTime: number;
    endTime: number;
}

export interface ProviderLyricsResult {
    lyrics: LyricData | null;
    mainText?: string | null;
    wordByWordText?: string | null;
    translationText?: string | null;
    romanizationText?: string | null;
    isPureMusic: boolean;
    chorusRanges?: ChorusRange[];
}

export interface ProviderSongMetadata {
    artists: ProviderArtistSummary[];
    album: ProviderAlbumSummary;
    durationMs: number;
    coverUrl?: string;
    aliases: string[];
    translatedNames: string[];
}

// ===== 以下为上表未列出、但被上面类型传递引用的定义（详见 task-1 报告）=====

// 摘自 src/types/onlineMusic.ts（ProviderCatalogRef 引用）
export type ProviderCatalogEntityKind = 'album' | 'artist' | 'playlist';

// 摘自 src/types/onlineMusic.ts（ProviderSongMetadata 引用）
export interface ProviderAlbumSummary {
    id: MediaId;
    name: string;
    coverUrl?: string;
    entityId?: string;
    catalogRef?: ProviderCatalogRef;
}

export interface ProviderArtistSummary {
    id: MediaId;
    name: string;
    entityId?: string;
    catalogRef?: ProviderCatalogRef;
}

// 摘自 src/utils/lyrics/renderHints.ts（Line.renderHints 引用）
export type LineTimingClass = 'normal' | 'short' | 'micro';
export type LineTransitionMode = 'normal' | 'fast' | 'none';
export type WordRevealMode = 'normal' | 'fast' | 'instant';

export interface LineRenderHints {
    rawDuration: number;
    timingClass: LineTimingClass;
    renderEndTime: number;
    lineTransitionMode: LineTransitionMode;
    wordRevealMode: WordRevealMode;
}

// 摘自 src/utils/lyrics/formatDetection.ts + parserCore.ts（lyricOptions.ts 的 RawLocalFileLyric.formatHint 引用）
export type TimedLyricFormat = 'lrc' | 'enhanced-lrc' | 'vtt' | 'ttml';
export type LyricParseFormat = TimedLyricFormat | 'yrc' | 'qrc' | 'krc' | 'awlrc';
