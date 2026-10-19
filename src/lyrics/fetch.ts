// 歌词获取的编排入口：歌名 + 歌手 + 时长 → 带逐字时间的歌词行。
//
// 上游 folia-major 做同样的事的是 autoMatchBestLyric.ts（555 行），但它依赖
// providerRegistry → store / 登录 / IndexedDB 那一整套宿主设施。本项目只要
// 「按顺序试几个源、打分挑最像的」，所以自己重写一个薄的，不搬那个。
//
// 三个源的能力差异（实测）：
//   qq     QRC 逐字，中文覆盖最好
//   kugou  KRC 逐字，和 EchoMusic 同源（它的 characters 就是解密 KRC 得来的）
//   amll   TTML 逐字，社区维护，冷门中文歌可能没收录
import type { Line, LyricData, SongResult } from './types.ts';
import { calculateMatchScoreDetails } from './matchScore.ts';
import { buildLyricSearchQuery } from './searchQuery.ts';
import { searchQQLyrics, fetchQQLyrics } from './providers/qq.ts';
import { searchKugouLyrics, fetchKugouLyrics } from './providers/kugou.ts';
import { searchAmllDbSongs, fetchAmllDbLyrics } from './providers/amllDbProvider.ts';

export type LyricSourceId = 'qq' | 'kugou' | 'amll';
export type LyricQuery = { title: string; artist?: string; durationSec?: number };
export type FetchLyricsOptions = { sources?: LyricSourceId[]; onLog?: (msg: string) => void };
export type FetchLyricsResult = {
  lines: Line[]; source: LyricSourceId;
  songName: string; artist: string; isWordByWord: boolean;
};

/** 默认顺序：酷狗 → QQ → AMLL（人工指定，不按命中率；顺序和 TUI 的「歌词源」一致）。 */
const DEFAULT_SOURCES: LyricSourceId[] = ['kugou', 'qq', 'amll'];

/**
 * 从「歌手 - 歌名」这类文件名里拆出歌手与歌名。
 * 只在**第一个**分隔符处切 —— 歌名自己带短横（"A - B - C"）时不能切碎。
 */
export function parseTrackName(raw: string): { artist: string; title: string } {
  const s = raw.replace(/\.[a-z0-9]+$/i, '').trim();   // 去扩展名
  const m = /^(.+?)\s*[-–—]\s*(.+)$/.exec(s);
  if (!m) return { artist: '', title: s };
  return { artist: m[1].trim(), title: m[2].trim() };
}

/**
 * 上游 Line 没有 text 字段（只有 fullText），本项目的 render.ts 读 `l.text ?? l.fullText`。
 * 直接喂也能跑，但补上 text 让两条路径产出的结构完全一致。
 *
 * 返回类型用 `Line & { text: string }` 而非纯 `Line`：那是「带 text 的 Line」，仍是 Line 的
 * 子类型（赋给 FetchLyricsResult.lines 的 Line[] 天然兼容），但让调用方能直接读 `.text`
 * 而无需再断言。**没有**去改 types.ts 的 Line —— 上游的 Line 本来就没有 text，加字段是主动
 * 偏离上游，会污染已审的 Task 1 产物；正确做法就是在这里用断言补齐。
 */
export function toRenderLines(lines: LyricData['lines']): Array<Line & { text: string }> {
  return lines.map((l) => ({ ...l, text: (l as Line & { text?: string }).text ?? l.fullText } as Line & { text: string }));
}

type Candidate = { song: SongResult; score: number };

/** 在各源里搜、按打分挑最像的一首，再取词。取到就返回，全部失败返回 null。 */
export async function fetchLyrics(
  query: LyricQuery,
  options: FetchLyricsOptions = {},
): Promise<FetchLyricsResult | null> {
  const log = options.onLog ?? (() => {});
  const sources = options.sources ?? DEFAULT_SOURCES;
  const target = {
    title: query.title,
    artist: query.artist ?? '',
    durationMs: Math.round((query.durationSec ?? 0) * 1000),
  };

  for (const source of sources) {
    try {
      // 关键词必须是「歌名 - 歌手」，第一段是歌名 —— 上游 provider 都按这个约定解析
      // （searchQuery.buildKugouLyricSearchQuery 就取第一段当歌名）。反着传（「歌手 - 歌名」）
      // 酷狗会把歌手名当歌名去搜，返回该歌手的热歌列表，于是"命中最像"的永远是别的歌。
      const keyword = buildLyricSearchQuery(query.title, query.artist);
      log(`  在 ${source} 搜索「${keyword}」…`);

      let data: LyricData | null = null;
      let picked: { name: string; artist: string } | null = null;

      if (source === 'qq' || source === 'kugou') {
        const songs = source === 'qq'
          ? await searchQQLyrics(keyword, 1, 10)
          : await searchKugouLyrics(keyword);
        if (songs.length === 0) { log(`    ${source} 没有候选`); continue; }

        const best = songs
          .map((song): Candidate => ({ song, score: calculateMatchScoreDetails(target, song as any).score }))
          .sort((a, b) => b.score - a.score)[0].song;

        picked = { name: best.name, artist: best.artists?.map((a) => a.name).join('/') ?? '' };
        data = source === 'qq' ? await fetchQQLyrics(best, {}) : await fetchKugouLyrics(best);
      } else {
        // ⚠️ searchAmllDbSongs 在「搜不到 / 限流 / 服务端错误 / 网络错误」时返回 **null**
        //（上游用 null 区分「搜不到」和「没搜成」），必须先兜住再取 length。
        const items = (await searchAmllDbSongs({ musicName: query.title, artistName: query.artist }, 10)) ?? [];
        if (items.length === 0) { log('    amll 没有候选'); continue; }
        const ncmId = items[0].ncmMusicIds?.[0];
        const qqId = items[0].qqMusicIds?.[0];
        const id = ncmId ?? qqId;
        if (!id) { log('    amll 候选没有可用 id'); continue; }
        picked = { name: items[0].musicNames?.[0] ?? query.title, artist: items[0].artistNames?.[0] ?? '' };
        data = await fetchAmllDbLyrics(ncmId ? 'ncm' : 'qq', id);
      }

      if (!data || data.lines.length === 0) { log(`    ${source} 没取到歌词`); continue; }

      log(`    ✓ ${picked.name} - ${picked.artist}（${data.isWordByWord ? '逐字' : '仅行级'}）`);
      return {
        lines: toRenderLines(data.lines),
        source,
        songName: picked.name,
        artist: picked.artist,
        isWordByWord: Boolean(data.isWordByWord),
      };
    } catch (error) {
      // 单个源失败不该拖垮整条链（网络抖动、格式变更都可能）
      log(`    ${source} 出错：${(error as Error).message}`);
    }
  }
  return null;
}
