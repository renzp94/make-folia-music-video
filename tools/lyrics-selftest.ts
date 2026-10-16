// 逐字歌词解析的自检。跑法：bun tools/lyrics-selftest.ts
//
// 只测「给定歌词文本 → 逐字时间对不对」。不测网络（那是 tools/lyrics-fetch-check.ts 的事）。
//
// 本文件里的每个样本都用上游 parserCore 实跑验证过（见计划 Task 2 Step 6 的说明）。
import assert from 'node:assert/strict';
import { parseLyricsByFormat } from '../src/lyrics/parserCore.ts';
import type { LyricData } from '../src/lyrics/types.ts';

// ⚠️ 上游解析器会**自动补「间奏点阵行」**：前奏 > 3 秒时，最前面插一条
// fullText === '......'（6 个点）的行；行间长间隙同理。这是刻意的 —— Folia 的
// diorama 等视觉模式靠它画倒计时点。所以 lines 里不止一行，
// **断言必须按内容找，不能按索引取**。
const pick = (r: LyricData, text: string) => r.lines.find((l) => l.fullText === text);

// ── KRC（酷狗）：[行起点ms,行时长ms]<字偏移ms,字时长ms,0>字
// 字偏移是「相对行首」（上游 parserCore.ts:1027 有注释确认），解析器会加上行起点
const k = parseLyricsByFormat('krc', '[12000,3470]<0,500,0>等待<500,500,0>换来<1000,600,0>是够钟');
assert.equal(k.isWordByWord, true, 'KRC 是真逐字');
assert.deepEqual(
  pick(k, '等待换来是够钟')?.words.map((w) => [w.text, w.startTime, w.endTime]),
  [['等待', 12, 12.5], ['换来', 12.5, 13], ['是够钟', 13, 13.6]],
);

// ── QRC（QQ）：[行起点ms,行时长ms]字(字起点ms,字时长ms)字
// ⚠️ 与 KRC 相反：QRC 的字时间是**绝对毫秒**（实测确认：某行起点 22.561s，
// 其首字 startTime 也是 22.561s）。所以样本里要把完整毫秒写出来，别写成从 0 开始。
const q = parseLyricsByFormat('qrc', '[12000,3470]等待(12000,500)换来(12500,500)是够钟(13000,600)');
assert.equal(q.isWordByWord, true);
assert.deepEqual(
  pick(q, '等待换来是够钟')?.words.map((w) => [w.text, w.startTime, w.endTime]),
  [['等待', 12, 12.5], ['换来', 12.5, 13], ['是够钟', 13, 13.6]],
);

// ── 增强 LRC：<mm:ss.xx>字
// 注意末字的 endTime 会取到「下一句起点」（没有下一句就是 start + 5）——
// 这是增强 LRC 格式本身的表达力限制：它只能说「什么时候开始」，说不了「什么时候结束」。
const e = parseLyricsByFormat('enhanced-lrc', '[00:12.00]<00:12.00>等待<00:12.50>换来<00:13.00>是够钟');
const el = pick(e, '等待换来是够钟');
assert.equal(el?.words[0].startTime, 12);
assert.equal(el?.words[1].startTime, 12.5);
assert.equal(el?.words[2].startTime, 13);

// ── 普通 LRC：没有逐字数据，靠 buildTimedWords 估算，isWordByWord 必须是 false
const plain = parseLyricsByFormat('lrc', '[00:12.00]等待换来是够钟');
assert.equal(plain.isWordByWord, false, 'LRC 是估算的，必须标记出来');
assert.equal(pick(plain, '等待换来是够钟')?.words.length, 7, '7 个汉字 → 7 个估算单元');

// ── TTML：AMLL 的格式，需要 DOMParser
const ttml = `<?xml version="1.0" encoding="utf-8"?>
<tt xmlns="http://www.w3.org/ns/ttml" xmlns:itunes="http://music.apple.com/lyric-ttml-internal" xmlns:ttm="http://www.w3.org/ns/ttml#metadata">
  <body><div>
    <p begin="12.000" end="13.600" itunes:key="L1" ttm:agent="v1"><span begin="12.000" end="12.500">等待</span><span begin="12.500" end="13.000">换来</span><span begin="13.000" end="13.600">是够钟</span></p>
  </div></body>
</tt>`;
const t = parseLyricsByFormat('ttml', ttml);
assert.deepEqual(
  pick(t, '等待换来是够钟')?.words.map((w) => [w.text, w.startTime, w.endTime]),
  [['等待', 12, 12.5], ['换来', 12.5, 13], ['是够钟', 13, 13.6]],
);

// ── 搜索词构造：歌名 + 歌手 → 送给 API 的 keyword
import { buildLyricSearchQuery, buildKugouLyricSearchQuery } from '../src/lyrics/searchQuery.ts';
assert.ok(buildLyricSearchQuery('街角的晚风', '陈小春').includes('街角的晚风'));
assert.ok(buildKugouLyricSearchQuery('街角的晚风').includes('街角的晚风'),
  '酷狗的搜索词要保留原标题，别做简繁转换');

// ── 打分：同名同歌手、时长接近的应当排第一
import { calculateMatchScoreDetails } from '../src/lyrics/matchScore.ts';
import { normalizeLyricMatchDurationMs } from '../src/lyrics/duration.ts';
const target = { title: '街角的晚风', artist: '陈小春', durationMs: 250_000 };
const exact = calculateMatchScoreDetails(target, {
  id: '1', name: '街角的晚风', artists: [{ name: '陈小春' }], durationMs: 249_000,
} as any);
const wrong = calculateMatchScoreDetails(target, {
  id: '2', name: '完全不相干的歌', artists: [{ name: '别人' }], durationMs: 100_000,
} as any);
assert.ok(exact.score > wrong.score, `精确匹配(${exact.score}) 必须高于错误匹配(${wrong.score})`);
assert.equal(exact.titleMatched, true);
assert.equal(exact.artistMatched, true);

// ── 时长归一：>12 小时视为误传的「毫秒×1000」
assert.equal(normalizeLyricMatchDurationMs(250_000), 250_000, '正常的毫秒原样返回');
assert.equal(normalizeLyricMatchDurationMs(250_000_000), 250_000, '误传的毫秒×1000 要还原');

console.log('✓ lyrics-selftest 全部通过');
