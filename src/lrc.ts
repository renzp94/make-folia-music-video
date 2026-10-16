// LRC / 增强 LRC 解析 → Folia 的 Line 结构
//
// 支持：
//   [mm:ss.xx]文字            逐行
//   [mm:ss.xx]<mm:ss.xx>字<...>逐字
//   [offset:±ms]              全局偏移（正值＝歌词提前，与 Folia 的 lyricTimelineOffsetMs 同向）
//   [ti:]/[ar:]/[al:]         元数据
// 忽略 [by:] 等无关标签。

/** 一个逐字/逐词单元。 */
export type Word = { text: string; startTime: number; endTime: number };

/** 一行歌词。 */
export type Line = {
  text: string; fullText: string;
  startTime: number; endTime: number;
  words: Word[];
  translation?: string; romanization?: string;
};

/** LRC 头部 [ti:]/[ar:]/[al:]/[offset:] → 小写键。 */
export type LrcMeta = Record<string, string>;

const TAG = /^\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]/;
const WORD = /<(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?>/g;
const META = /^\[(ti|ar|al|offset):(.*)\]$/i;

const toSec = (m: string, s: string, frac: string | undefined): number => {
  const base = Number(m) * 60 + Number(s);
  if (frac == null) return base;
  const f = String(frac);
  // 2 位=厘秒，3 位=毫秒，1 位=十分之一秒
  const ms = f.length === 1 ? Number(f) * 100 : f.length === 2 ? Number(f) * 10 : Number(f);
  return base + ms / 1000;
};

/**
 * @param {string} text
 * @param {number} extraOffsetMs 额外的全局偏移（毫秒），叠加在 LRC 自带的 [offset:] 上。
 *        符号与 Folia 的 lyricTimelineOffsetMs 一致：正值 = 歌词提前。
 */
// 把一行没有逐字标签的歌词摊成带时间的 words。
// 逐字移植自 Folia 的 src/utils/lyrics/parserCore.ts:buildTimedWords —— 这段决定了
// 「歌词跟不跟得上唱」，两边算法必须一致：
//   · 中文逐字拆开，每字权重 1；标点权重 0（不占时间）
//   · 英文按**整词**算一个单位，权重 1 + 词长×0.15（拆成字母会让高亮节奏完全崩掉）
//   · 只占用时长的 90%，留 10% 收尾，否则整句会比实际唱得慢半拍
const CJK = /[\u4e00-\u9fa5\u3040-\u30ff\uac00-\ud7af]/;
const PUNCT = /[，。！？、：；"'）]/;

export function buildTimedWords(text: string, startTime: number, endTime: number): Word[] {
  const duration = Math.max(endTime - startTime, 0.1);
  const tokens: { text: string; weight: number }[] = [];
  let totalWeight = 0;

  for (const token of String(text).split(/\s+/).filter(Boolean)) {
    if (CJK.test(token)) {
      for (const char of token) {
        const weight = PUNCT.test(char) ? 0 : 1;
        tokens.push({ text: char, weight });
        totalWeight += weight;
      }
    } else {
      const weight = 1 + token.length * 0.15;
      tokens.push({ text: token, weight });
      totalWeight += weight;
    }
  }
  if (totalWeight === 0) totalWeight = 1;

  const timePerWeight = (duration * 0.9) / totalWeight;
  const words: Word[] = [];
  let cursor = startTime;
  for (const token of tokens) {
    const wordDuration = token.weight * timePerWeight;
    const finalDuration = Math.max(wordDuration, 0.05);
    words.push({ text: token.text, startTime: cursor, endTime: cursor + finalDuration });
    cursor += token.weight > 0 ? wordDuration : 0.05;
  }

  // 权重取整后可能溢出到 endTime 之外，等比压回来（同 Folia）。
  const last = words[words.length - 1];
  if (last && last.endTime > endTime) {
    const span = endTime - startTime;
    const scale = span / (last.endTime - startTime);
    for (const w of words) {
      w.startTime = startTime + (w.startTime - startTime) * scale;
      w.endTime = startTime + (w.endTime - startTime) * scale;
    }
  }
  return words;
}

export function parseLrc(text: string, extraOffsetMs = 0): { lines: Line[]; meta: LrcMeta; offset: number } {
  const meta: LrcMeta = {};
  const raw: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const m = META.exec(line.trim());
    if (m) { meta[m[1].toLowerCase()] = m[2].trim(); continue; }
    if (!TAG.test(line)) continue;
    raw.push(line);
  }
  const offsetSec = ((Number(meta.offset) || 0) + extraOffsetMs) / 1000;

  // 一行可能有多个时间标签（同一句重复出现）
  const entries: { start: number; body: string }[] = [];
  for (const line of raw) {
    let rest = line;
    const stamps: number[] = [];
    let m: RegExpExecArray | null;
    while ((m = TAG.exec(rest))) { stamps.push(toSec(m[1], m[2], m[3])); rest = rest.slice(m[0].length); }
    const body = rest;
    for (const t of stamps) entries.push({ start: t - offsetSec, body });
  }
  entries.sort((a, b) => a.start - b.start);

  const lines: Line[] = [];
  for (let i = 0; i < entries.length; i++) {
    const { start, body } = entries[i];
    // 同 Folia：默认把到下一句的间隔都算作本句，但间隔明显过长时按
    // 「估算朗读时间(字符数×0.5) + 2 秒」截断，否则长间奏会让上一句一直挂着。
    let nextStart = i + 1 < entries.length ? entries[i + 1].start : start + 5;
    const estimatedReadingTime = body.length * 0.5;
    if (nextStart - start > estimatedReadingTime + 2 && nextStart - start > 5) {
      nextStart = start + Math.min(nextStart - start, estimatedReadingTime + 2);
    }

    // 逐字标签
    const words: Word[] = [];
    let last = 0, mm: RegExpExecArray | null, cursor = 0, pending = null;
    WORD.lastIndex = 0;
    const marks: { at: number; len: number; t: number }[] = [];
    while ((mm = WORD.exec(body))) marks.push({ at: mm.index, len: mm[0].length, t: toSec(mm[1], mm[2], mm[3]) - offsetSec });
    if (marks.length > 0) {
      // 标签在文字之前：<t>字< t >字
      const textOnly = body.replace(WORD, '\u0000');
      const pieces = textOnly.split('\u0000');
      for (let k = 1; k < pieces.length; k++) {
        const t0 = marks[k - 1]?.t ?? start;
        const t1 = marks[k]?.t ?? nextStart;
        const txt = pieces[k];
        if (txt) words.push({ text: txt, startTime: t0, endTime: Math.max(t0, t1) });
      }
    }

    const fullText = body.replace(WORD, '').trim();
    if (!fullText) continue;

    if (words.length === 0) {
      words.push(...buildTimedWords(fullText, start, nextStart));
    }

    lines.push({
      text: fullText, fullText,
      startTime: words[0].startTime,
      endTime: words[words.length - 1].endTime,
      words,
    });
  }
  return { lines, meta, offset: offsetSec };
}
