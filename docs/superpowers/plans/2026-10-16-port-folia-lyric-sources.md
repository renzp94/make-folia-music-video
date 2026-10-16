# 移植 Folia 歌词获取模块 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 folia-music-video 能按「歌名 + 歌手 + 时长」自动获取**带逐字时间**的歌词，不再依赖用户手头那份行级 LRC。

**Architecture:** 从 `folia-major` 移植解析核心（`parserCore` 及配套 utils）与三个歌词源 provider（QQ QRC / 酷狗 KRC / AMLL TTML），**保持上游文件名与导出签名不变**；网络层删掉 CORS 代理分支改为直连（Bun 无 CORS 限制）；另写一个薄编排层把「歌名+歌手+时长」接到上游的搜索/取词函数上，产出本项目 `render.ts` 认识的 `Line[]`。

**Tech Stack:** Bun + TypeScript。新增 5 个 npm 依赖，无框架。

**上游根目录（下称 `$UP`）：** `/Users/mr.r/Documents/xgamer/github/renzp94/folia-major/src`

---

## Global Constraints

- **保持上游文件名与导出签名。** 移植来的文件不改函数名、不改参数顺序、不重构内部结构 —— 唯一目的是让将来 `git diff` 上游时能一眼看出改了哪几行。
- **每个移植文件头部加一段来源注释**，格式固定：
  ```
  // 移植自 folia-major src/utils/lyrics/parserCore.ts @ 7db1ad56
  // 改动：无
  ```
  或改动项逐条列出。
- **网络请求一律直连**，删除所有 `isElectron ? ... : /api/lyric-proxy?...` 分支和 `window.electron` IPC 分支。
- **时间单位：秒**（浮点）。上游 `Word.startTime/endTime`、`Line.startTime/endTime` 都是秒。唯一例外是匹配打分的 `durationMs` 参数，单位毫秒，函数名带 `Ms` 后缀。
- **本项目不是 git 仓库**，因此本计划**不含 commit 步骤**。每个任务的检查点是「自检脚本通过 + `bun check` 无类型错误」。
- **不改动现有 `src/lrc.ts` 的行为** —— 它是离线文件路径，继续用。新模块与它并存。
- 上游许可证是 AGPL-3.0（本项目因 `site/visualizer.js` 已在 AGPL 覆盖下）。移植文件保留其原有的许可证头（若有）。

---

## 文件结构

新建 `src/lyrics/` 目录，平铺上游结构（去掉上游的 `utils/` 中间层）：

```
src/lyrics/
  types.ts                   ← 上游 src/types.ts 的切片（只取歌词与歌曲元数据相关类型）
  lyricOptions.ts            ← 上游 src/utils/lyrics/types.ts（改个名，避免与上面的 types.ts 撞名）
  parserCore.ts              ← 逐字解析总入口 parseLyricsByFormat
  formatDetection.ts
  renderHints.ts
  ttmlConversion.ts
  chorusEffects.ts
  chorusDetector.ts          ← 上游在 src/utils/ 不在 src/utils/lyrics/
  searchQuery.ts
  matchScore.ts
  songMetadata.ts            ← 上游 src/utils/songMetadata.ts
  sourcePriority.ts
  validity.ts
  duration.ts
  filtering.ts
  fetch.ts                   ← 【新写】本项目自己的编排入口
  providers/
    qq.ts                    ← 上游 qqLyricProvider.ts（改名去后缀，下同）
    kugou.ts
    amllApi.ts
    amllDbProvider.ts
    qrcDecrypt.ts
    krcDecrypt.ts
tools/
  lyrics-selftest.ts         ← 【新写】自检脚本，沿用 tools/lrc-selftest.ts 的风格
```

**为什么 `qq.ts` 而不是 `qqLyricProvider.ts`**：目录已经叫 `providers/`，后缀是冗余。但**文件内的导出名不变**（仍是 `searchQQLyrics` / `fetchQQLyrics`）。

**为什么不搬 `autoMatchBestLyric.ts`**：它是「多源自动择优」的编排层（555 行），依赖 `providerRegistry`（那整条链拖进 store/登录/IndexedDB）。我们用 30 行的 `fetch.ts` 自己编排，反而更符合本项目的形态。

---

## Task 1: 依赖与类型切片

**Files:**
- Modify: `package.json`
- Create: `src/lyrics/types.ts`
- Create: `src/lyrics/lyricOptions.ts`

**Interfaces:**
- Consumes: 无
- Produces: `src/lyrics/types.ts` 导出 `Word` / `Line` / `LyricData` / `SongResult` / `Artist` / `Album` 等；`src/lyrics/lyricOptions.ts` 导出 `LyricProcessingOptions`。

- [ ] **Step 1: 装依赖**

```bash
cd /Users/mr.r/Documents/xgamer/github/renzp94/folia-music-video
bun add @applemusic-like-lyrics/ttml@1.0.1 @xmldom/xmldom@0.9.12 blueimp-md5@2.19.0 wanakana@5.3.1 opencc-js@1.4.2
```

`wanakana` 与 `opencc-js` 只被 `matchScore.ts` 使用（歌名匹配时做日文罗马音 / 简繁归一）。若后续嫌体积大，可单独替换 —— 但先搬，保证与 Folia 打分一致。

- [ ] **Step 2: 验证 5 个包在 Bun 下都能 import**

```bash
bun -e "
import { TTMLParser } from '@applemusic-like-lyrics/ttml';
import { DOMParser } from '@xmldom/xmldom';
import md5 from 'blueimp-md5';
import { toRomaji } from 'wanakana';
import * as OpenCC from 'opencc-js';
console.log('ttml:', typeof TTMLParser, '| dom:', typeof DOMParser, '| md5:', md5('a'), '| wanakana:', toRomaji('あ'), '| opencc:', typeof OpenCC.Converter);
"
```

Expected: 五个值全部打印出来，无异常。`md5('a')` 应为 `0cc175b9c0f1b6a831c399e269772661`。

- [ ] **Step 3: 切片主类型 → `src/lyrics/types.ts`**

从 `$UP/types.ts`（共 1435 行）**只摘下列行范围**，按原顺序放进新文件。**不要整拷** —— 该文件头部第 1 行 `import type { LucideIcon } from 'lucide-react'`、第 1422 行 `import { MotionValue } from 'framer-motion'`，整拷会把 UI 库拖进来。

| 类型 | `$UP/types.ts` 行范围 |
|---|---|
| `LyricRuby` | 5-9 |
| `LyricSyllable` | 11-19 |
| `LyricAlternateText` | 21-26 |
| `Word` | 28-33 |
| `LyricBackgroundVocal` | 35-44 |
| `LyricAgent` | 50-54 |
| `Line` | 56-80 |
| `LyricData` | 82-91 |
| `Artist` | 1188-1193 |
| `Album` | 1195-1201 |
| `SongPrivilege` | 1203-1212 |
| `NoCopyrightRecommendation` | 1214-1220 |
| `LyricProviderSource` | 1222 |
| `AmllDbPlatform` | 1223 |
| `ReplayGainInfo` | 1225-1232 |
| `SongResult` | 1234-1259 |
| `OnlineLyricsState` | 1261-1271 |

同时从 `$UP/types/onlineMusic.ts` 摘：

| 类型 | 行范围 |
|---|---|
| `MediaId` | 5 |
| `OnlineProviderId` | 6 |
| `ProviderCatalogRef` | 10-14 |
| `JsonValue` | 16-17 |
| `PlaybackSourceRef` | 19-29 |
| `ChorusRange` | 111-114 |
| `ProviderLyricsResult` | 116-124 |
| `ProviderSongMetadata` | 134 起（到该 interface 结束） |

**摘完全部放进同一个 `src/lyrics/types.ts`**，并在文件头写：

```ts
// 移植自 folia-major src/types.ts + src/types/onlineMusic.ts @ 7db1ad56
// 改动：只摘取歌词解析与歌曲元数据相关的类型；删掉了 UI 相关 import（lucide-react / framer-motion）
//      和 UnifiedSong（只有 neteaseProvider 用，本项目不涉及）。
```

- [ ] **Step 4: 验证类型文件自洽**

```bash
bun check
```

Expected: `✓ No type errors in N files`。若报「找不到名称 X」，说明上表漏摘了那个被引用的类型，补上再跑。

- [ ] **Step 5: 拷 `lyricOptions.ts`**

```bash
cp "$UP/utils/lyrics/types.ts" src/lyrics/lyricOptions.ts
```

在文件头加来源注释（照 Global Constraints 的格式）。

- [ ] **Step 6: 检查 `lyricOptions.ts` 有没有引用被排除的类型**

```bash
grep -n "^import\|from '" src/lyrics/lyricOptions.ts
```

Expected: 只 import 自 `./types`。若引用了 `RawNavidromeLyric`（上游用它支持 Navidrome），删掉那个接口及其 import —— 本项目不涉及。

- [ ] **Step 7: `bun check` 通过**

```bash
bun check
```

Expected: 无类型错误。

---

## Task 2: 解析核心

这是整块的地基：所有 provider 拿到的原始歌词文本，最终都经过 `parseLyricsByFormat` 变成 `LyricData`。**这一步零改动**（除了加来源注释）。

**Files:**
- Create: `src/lyrics/parserCore.ts`
- Create: `src/lyrics/formatDetection.ts`
- Create: `src/lyrics/ttmlConversion.ts`
- Create: `src/lyrics/renderHints.ts`
- Create: `src/lyrics/validity.ts`
- Test: `tools/lyrics-selftest.ts`

**Interfaces:**
- Consumes: `src/lyrics/types.ts`
- Produces:
  - `parseLyricsByFormat(format: LyricParseFormat, content: string, translation?: string, options?: LyricProcessingOptions, romanization?: string): LyricData`
  - `LyricParseFormat = 'lrc' | 'enhanced-lrc' | 'vtt' | 'ttml' | 'yrc' | 'qrc' | 'krc' | 'awlrc'`
  - `Line.words: Word[]`，`Word = { text: string; startTime: number; endTime: number; syllables?: LyricSyllable[] }`，时间单位**秒**

- [ ] **Step 1: 先写失败的自检**

创建 `tools/lyrics-selftest.ts`，沿用 `tools/lrc-selftest.ts` 的 `node:assert/strict` 风格：

```ts
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
assert.equal(pick(plain, '等待换来是够钟')?.words.length, 6, '6 个汉字 → 6 个估算单元');

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

console.log('✓ lyrics-selftest 全部通过');
```

- [ ] **Step 2: 跑它，确认失败**

```bash
bun tools/lyrics-selftest.ts
```

Expected: FAIL —— `Cannot find module '../src/lyrics/parserCore.ts'`。

- [ ] **Step 3: 拷解析核心的 5 个文件**

```bash
cd /Users/mr.r/Documents/xgamer/github/renzp94/folia-music-video
cp "$UP/utils/lyrics/parserCore.ts"       src/lyrics/parserCore.ts
cp "$UP/utils/lyrics/formatDetection.ts"  src/lyrics/formatDetection.ts
cp "$UP/utils/lyrics/ttmlConversion.ts"   src/lyrics/ttmlConversion.ts
cp "$UP/utils/lyrics/renderHints.ts"      src/lyrics/renderHints.ts
cp "$UP/utils/lyrics/validity.ts"         src/lyrics/validity.ts
```

（`$UP` 是上文定义的上游根目录，执行时展开成完整路径。）

- [ ] **Step 4: 修 import 路径**

上游的相对路径深度是 `src/utils/lyrics/x.ts` → `../../types`；新位置是 `src/lyrics/x.ts` → `./types`。**用 sed 批量改，别手改**：

```bash
cd /Users/mr.r/Documents/xgamer/github/renzp94/folia-music-video
sed -i '' "s|from '\.\./\.\./types'|from './types'|g"  src/lyrics/parserCore.ts src/lyrics/ttmlConversion.ts src/lyrics/renderHints.ts
sed -i '' "s|from '\.\./\.\./types/onlineMusic'|from './types'|g" src/lyrics/*.ts
sed -i '' "s|from '\./types'|from './lyricOptions'|g" src/lyrics/lyricOptions.ts 2>/dev/null || true
```

然后**逐个检查剩下的 import**：

```bash
grep -n "from '" src/lyrics/parserCore.ts src/lyrics/formatDetection.ts src/lyrics/ttmlConversion.ts src/lyrics/renderHints.ts src/lyrics/validity.ts
```

Expected: 只出现 `./types`、`./lyricOptions`、`./ttmlConversion`、`./formatDetection`、`./renderHints` 和三个 npm 包（`@applemusic-like-lyrics/ttml`、`@xmldom/xmldom`）。出现任何 `../` 或 `../../` 都要改成新位置。

- [ ] **Step 5: 给 5 个文件加来源注释**

在每个文件头加：

```ts
// 移植自 folia-major src/utils/lyrics/parserCore.ts @ 7db1ad56
// 改动：只改了 import 路径（../../types → ./types）。
```

（其余 4 个同理，路径按各自上游位置填写。）

- [ ] **Step 6: 跑自检，确认通过**

```bash
bun tools/lyrics-selftest.ts
```

Expected: `✓ lyrics-selftest 全部通过`

**本步的样本已全部用上游 `parserCore` 实跑验证过**（含期望值）。所以：

- **若 KRC/QRC 段失败** → 不是样本的问题，是**搬运出了问题**（import 路径没改全、文件没拷全）。回去跑 Step 4 的 grep。
- **若 TTML 段失败** → 检查 `new DOMParser()` 是否传进了 `TTMLParser.parse()`（上游 `parserCore.ts:818` 附近的 `parseTTML`）。Bun 无原生 `DOMParser`，必须用 `@xmldom/xmldom` 那个，这个依赖不能省。
- **若「间奏行」导致断言失败** → 说明你按索引取值了。用上面的 `pick()` 按 `fullText` 找目标行。

**两条容易搞混的格式约定**（实测确认，别弄反）：
- **KRC** 字偏移 `<偏移ms,时长ms,0>` 是**相对行首**的 → 解析器加行起点
- **QRC** 字时间 `(起点ms,时长ms)` 是**绝对毫秒**的 → 解析器直接用

- [ ] **Step 7: `bun check` 通过**

```bash
bun check
```

Expected: 无类型错误。

---

## Task 3: 辅助工具层

这些是 provider 的依赖：歌词搜索词构造、结果打分、副歌标记、时长归一。

**Files:**
- Create: `src/lyrics/searchQuery.ts`
- Create: `src/lyrics/matchScore.ts`
- Create: `src/lyrics/songMetadata.ts`
- Create: `src/lyrics/sourcePriority.ts`
- Create: `src/lyrics/duration.ts`
- Create: `src/lyrics/chorusEffects.ts`
- Create: `src/lyrics/chorusDetector.ts`
- Create: `src/lyrics/filtering.ts`
- Test: `tools/lyrics-selftest.ts`（追加）

**Interfaces:**
- Consumes: `src/lyrics/types.ts`
- Produces:
  - `buildLyricSearchQuery(...)` / `buildKugouLyricSearchQuery(keyword: string): string`
  - `calculateMatchScoreDetails(target: { title: string; artist: string; durationMs: number }, song: SongResult): { score: number; titleMatched: boolean; artistMatched: boolean }`
  - `normalizeLyricMatchDurationMs(value: number): number`
  - `applyDetectedChorusEffects(...)` / `applyNeteaseChorusByTime(...)`

- [ ] **Step 1: 追加失败的自检**

在 `tools/lyrics-selftest.ts` 末尾（`console.log` 之前）插入：

```ts
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
```

- [ ] **Step 2: 跑，确认失败**

```bash
bun tools/lyrics-selftest.ts
```

Expected: FAIL —— 找不到 `../src/lyrics/searchQuery.ts`。

- [ ] **Step 3: 拷这 8 个文件**

```bash
cd /Users/mr.r/Documents/xgamer/github/renzp94/folia-music-video
cp "$UP/utils/lyrics/searchQuery.ts"    src/lyrics/searchQuery.ts
cp "$UP/utils/lyrics/matchScore.ts"     src/lyrics/matchScore.ts
cp "$UP/utils/songMetadata.ts"          src/lyrics/songMetadata.ts
cp "$UP/utils/lyrics/sourcePriority.ts" src/lyrics/sourcePriority.ts
cp "$UP/utils/lyrics/duration.ts"       src/lyrics/duration.ts
cp "$UP/utils/lyrics/chorusEffects.ts"  src/lyrics/chorusEffects.ts
cp "$UP/utils/chorusDetector.ts"        src/lyrics/chorusDetector.ts
cp "$UP/utils/lyrics/filtering.ts"      src/lyrics/filtering.ts
```

注意 `songMetadata.ts` 和 `chorusDetector.ts` 上游在 `$UP/utils/` 而不是 `$UP/utils/lyrics/` —— 搬过来后统一平铺在 `src/lyrics/`。

- [ ] **Step 4: 修 import 路径**

```bash
cd /Users/mr.r/Documents/xgamer/github/renzp94/folia-music-video
sed -i '' "s|from '\.\./\.\./types'|from './types'|g"        src/lyrics/*.ts
sed -i '' "s|from '\.\./\.\./types/onlineMusic'|from './types'|g" src/lyrics/*.ts
sed -i '' "s|from '\./types'|from './lyricOptions'|g"        src/lyrics/lyricOptions.ts
sed -i '' "s|from '\.\./chorusDetector'|from './chorusDetector'|g" src/lyrics/chorusEffects.ts
sed -i '' "s|from '\.\./songMetadata'|from './songMetadata'|g"     src/lyrics/*.ts
sed -i '' "s|from '\.\./coverUrl'|from './coverUrl'|g"             src/lyrics/*.ts
```

然后逐个文件检查：

```bash
grep -n "from '" src/lyrics/*.ts | grep -v "^src/lyrics/[a-z]*\.ts:[0-9]*://" | grep -E "\.\./"
```

Expected: **无输出**。任何 `../` 残留都要改。

- [ ] **Step 5: 处理 `coverUrl`（可选依赖）**

`matchScore.ts` 或 QQ provider 会用到 `getOriginalCoverUrl`。两个选择：

**建议直接内联掉**，别为它多搬一个 210 行的文件。找到引用处，把 `getOriginalCoverUrl(x)` 换成 `x`（返回原始 URL 即可，封面缩图对渲染无影响）。

```bash
grep -rn "coverUrl\|getOriginalCoverUrl" src/lyrics/*.ts
```

- [ ] **Step 6: 加来源注释，跑自检**

```bash
bun tools/lyrics-selftest.ts
```

Expected: `✓ lyrics-selftest 全部通过`

- [ ] **Step 7: `bun check` 通过**

```bash
bun check
```

Expected: 无类型错误。若报 `wanakana`/`opencc-js` 找不到类型，检查 package.json 里是否装上了（Task 1 Step 1）。

---

## Task 4: QQ 音乐源

**Files:**
- Create: `src/lyrics/providers/qq.ts`
- Create: `src/lyrics/providers/qrcDecrypt.ts`
- Test: `tools/lyrics-fetch-check.ts`

**Interfaces:**
- Consumes: `parseLyricsByFormat`、`calculateMatchScoreDetails`
- Produces:
  - `searchQQLyrics(keyword: string, page?: number, pageSize?: number): Promise<SongResult[]>`
  - `fetchQQLyrics(song: SongResult, options?: { chorusRanges?: unknown[] }): Promise<LyricData | null>`

- [ ] **Step 1: 拷文件**

```bash
cd /Users/mr.r/Documents/xgamer/github/renzp94/folia-music-video
cp "$UP/utils/lyrics/providers/qqLyricProvider.ts" src/lyrics/providers/qq.ts
cp "$UP/utils/lyrics/providers/qrcDecrypt.ts"      src/lyrics/providers/qrcDecrypt.ts
```

- [ ] **Step 2: 改网络层为直连（3 处）**

打开 `src/lyrics/providers/qq.ts`，按行号改：

**第 16 行附近** —— 删掉 `isElectron` 常量：
```ts
// 删掉这一行：
const isElectron = typeof window !== 'undefined' && (window as any).electron;
```

**第 43 行附近** —— 直连：
```ts
// 改前：
const url = isElectron ? targetUrl : `/api/lyric-proxy?url=${encodeURIComponent(targetUrl)}`;
// 改后（Bun 里没有 CORS 限制，直接请求原地址）：
const url = targetUrl;
```

**第 47 行附近** —— credentials：
```ts
// 改前：
credentials: isElectron ? 'omit' : 'same-origin',
// 改后：
credentials: 'omit',
```

- [ ] **Step 3: 修 import 路径**

```bash
cd /Users/mr.r/Documents/xgamer/github/renzp94/folia-music-video
sed -i '' "s|from '\.\./\.\./\.\./types'|from '../types'|g" src/lyrics/providers/*.ts
sed -i '' "s|from '\.\./types'|from '../types'|g"           src/lyrics/providers/*.ts
sed -i '' "s|from '\.\./parserCore'|from '../parserCore'|g"  src/lyrics/providers/*.ts
sed -i '' "s|from '\.\./formatDetection'|from '../formatDetection'|g" src/lyrics/providers/*.ts
sed -i '' "s|from '\.\./chorusEffects'|from '../chorusEffects'|g"     src/lyrics/providers/*.ts
sed -i '' "s|from '\.\./searchQuery'|from '../searchQuery'|g"         src/lyrics/providers/*.ts
sed -i '' "s|from '\.\./\.\./coverUrl'|from './coverUrl'|g"           src/lyrics/providers/*.ts
grep -n "from '" src/lyrics/providers/*.ts | grep "\.\./"
```

Expected: 最后一条 grep **无输出**。

- [ ] **Step 4: 写联网冒烟脚本**

创建 `tools/lyrics-fetch-check.ts`：

```ts
// 联网冒烟：真去 QQ 音乐搜一首歌并把逐字歌词打出来。
// 跑法：bun tools/lyrics-fetch-check.ts "陈小春 - 街角的晚风"
// 依赖网络，不放进 CI；解析逻辑的测试在 lyrics-selftest.ts 里。
import { searchQQLyrics, fetchQQLyrics } from '../src/lyrics/providers/qq.ts';
import { calculateMatchScoreDetails } from '../src/lyrics/matchScore.ts';

const keyword = process.argv[2] ?? '周杰伦 - 给我一首歌的时间';
const songs = await searchQQLyrics(keyword, 1, 10);
console.log(`搜索「${keyword}」→ ${songs.length} 条候选`);
for (const s of songs.slice(0, 3)) {
  console.log(`  · ${s.name} - ${s.artists?.map((a: any) => a.name).join('/')} (${s.durationMs}ms)`);
}
if (songs.length === 0) process.exit(0);

const target = { title: keyword.split(' - ')[1] ?? keyword, artist: keyword.split(' - ')[0] ?? '', durationMs: songs[0].durationMs };
const best = songs
  .map((s) => ({ s, score: calculateMatchScoreDetails(target, s as any).score }))
  .sort((a, b) => b.score - a.score)[0].s;
console.log(`选中：${best.name}（${best.id}）`);

const data = await fetchQQLyrics(best, {});
if (!data) { console.log('没取到歌词'); process.exit(1); }
console.log(`isWordByWord=${data.isWordByWord}  行数=${data.lines.length}`);
const withWords = data.lines.find((l) => l.words.length > 1);
if (withWords) {
  console.log(`逐字样例「${withWords.fullText}」：`);
  for (const w of withWords.words.slice(0, 5)) {
    console.log(`    「${w.text}」 ${w.startTime.toFixed(2)}~${w.endTime.toFixed(2)}s`);
  }
}
```

- [ ] **Step 5: 跑它**

```bash
bun tools/lyrics-fetch-check.ts "陈小春 - 街角的晚风"
```

Expected: 打印出候选列表和逐字样例，`isWordByWord=true`。

**若报 `fetch failed` 或拿到空**：说明还有 `/api/lyric-proxy` 残留 —— 回去跑 Step 3 的 grep。

**若 `isWordByWord=false`**：QQ 返回的是普通 LRC（这歌没 QRC 逐字版）。换一首知名的再试，比如周杰伦的歌。

- [ ] **Step 6: `bun check` 通过**

```bash
bun check
```

---

## Task 5: 酷狗源

**Files:**
- Create: `src/lyrics/providers/kugou.ts`
- Create: `src/lyrics/providers/krcDecrypt.ts`

**Interfaces:**
- Produces:
  - `searchKugouLyrics(keyword: string, pageSize?: number): Promise<SongResult[]>`
  - `fetchKugouLyrics(song: SongResult): Promise<LyricData | null>`

- [ ] **Step 1: 拷文件**

```bash
cd /Users/mr.r/Documents/xgamer/github/renzp94/folia-music-video
cp "$UP/utils/lyrics/providers/kugouLyricProvider.ts" src/lyrics/providers/kugou.ts
cp "$UP/utils/lyrics/providers/krcDecrypt.ts"         src/lyrics/providers/krcDecrypt.ts
```

- [ ] **Step 2: 改网络层为直连（2 处）**

**第 17 行附近**：删掉 `const isElectron = ...`。

**第 118 行、第 234 行附近**（两处，搜 `lyric-proxy`）：
```ts
// 改前：
const requestUrl = isElectron ? finalUrl : `/api/lyric-proxy?url=${encodeURIComponent(finalUrl)}`;
// 改后：
const requestUrl = finalUrl;
```

验证没有残留：
```bash
grep -n "lyric-proxy\|isElectron" src/lyrics/providers/kugou.ts
```
Expected: 无输出。

- [ ] **Step 3: 修 import 路径**

```bash
cd /Users/mr.r/Documents/xgamer/github/renzp94/folia-music-video
grep -n "from '" src/lyrics/providers/kugou.ts | grep "\.\./"
```
Expected: 无输出（Task 4 Step 3 的 sed 已经覆盖了 providers/ 下所有文件）。

- [ ] **Step 4: 加来源注释（两个文件）**

- [ ] **Step 5: 联网冒烟**

在 `tools/lyrics-fetch-check.ts` 末尾追加酷狗分支（或另开一个参数分支）：

```ts
// 用法：bun tools/lyrics-fetch-check.ts "陈小春 - 街角的晚风" kugou
if (process.argv[3] === 'kugou') {
  const { searchKugouLyrics, fetchKugouLyrics } = await import('../src/lyrics/providers/kugou.ts');
  const list = await searchKugouLyrics(keyword);
  console.log(`酷狗 → ${list.length} 条候选`);
  if (list.length) {
    const d = await fetchKugouLyrics(list[0]);
    console.log(`isWordByWord=${d?.isWordByWord}  行数=${d?.lines.length}`);
    const l = d?.lines.find((x) => x.words.length > 1);
    if (l) for (const w of l.words.slice(0, 5)) console.log(`    「${w.text}」 ${w.startTime.toFixed(2)}~${w.endTime.toFixed(2)}s`);
  }
}
```

```bash
bun tools/lyrics-fetch-check.ts "陈小春 - 街角的晚风" kugou
```

Expected: 打印候选与逐字时间。酷狗的下载响应可能是加密 KRC，`decodeKugouDownloadedLyric` 会先看有没有 `krc1` 头再解密 —— 如果这步出错，日志里会有迹象。

- [ ] **Step 6: `bun check` 通过**

---

## Task 6: AMLL TTML 源

**Files:**
- Create: `src/lyrics/providers/amllApi.ts`
- Create: `src/lyrics/providers/amllDbProvider.ts`

**Interfaces:**
- Produces:
  - `searchAmllDbSongs(query: { musicName?: string; artistName?: string }, limit?: number): Promise<AmllDbItem[]>`
  - `fetchAmllDbLyrics(platform: AmllDbPlatform, musicId: string): Promise<LyricData | null>`

- [ ] **Step 1: 拷文件**

```bash
cd /Users/mr.r/Documents/xgamer/github/renzp94/folia-music-video
cp "$UP/utils/lyrics/providers/amllApi.ts"       src/lyrics/providers/amllApi.ts
cp "$UP/utils/lyrics/providers/amllDbProvider.ts" src/lyrics/providers/amllDbProvider.ts
```

- [ ] **Step 2: 删掉 Electron IPC 分支（`amllApi.ts` 第 80-88 行附近）**

```ts
// 删掉这几行：
const electronBridge = typeof window === 'undefined' ? undefined : window.electron;
if (electronBridge?.fetchLyricProxy) {
  const response = await electronBridge.fetchLyricProxy(url, { ... });
  ...
}
```

**只保留**下面那个真正的 `fetch`（第 90 行附近）：

```ts
const response = await fetch(url, {
  credentials: 'omit',
  signal: AbortSignal.timeout(5000),
});
```

`api.amll.dev` 支持 CORS，Bun 里直连即可。

- [ ] **Step 3: 处理 `__APP_VERSION__`（第 70-77 行附近）**

上游读构建期注入的常量拼 User-Agent。Bun 里该常量未定义 → 返回 null → 不带 UA。**不改也能跑**，但为了干净，改成：

```ts
// 改前：读 __APP_VERSION__ 等构建常量
// 改后：直接返回 null（不带 UA），或读 Bun.env
const getAmllApiUserAgent = (): string | null => null;
```

- [ ] **Step 4: 修 import 路径 + 加来源注释**

```bash
grep -n "from '" src/lyrics/providers/amll*.ts | grep "\.\./"
```
Expected: 无输出。

- [ ] **Step 5: 联网冒烟**

```bash
cd /Users/mr.r/Documents/xgamer/github/renzp94/folia-music-video
bun -e "
import { searchAmllDbSongs, fetchAmllDbLyrics } from './src/lyrics/providers/amllDbProvider.ts';
const items = await searchAmllDbSongs({ musicName: '晴天', artistName: '周杰伦' }, 5);
console.log('候选:', items.length);
if (items[0]) {
  const id = items[0].ncmMusicIds?.[0];
  console.log('ncmId:', id);
  const d = await fetchAmllDbLyrics('ncm', id);
  console.log('isWordByWord:', d?.isWordByWord, '行数:', d?.lines.length);
}
"
```

Expected: 打印候选数和 `isWordByWord: true`。

**若解析出 0 行**：AMLL 的 TTML 要求每个 `<p>` 带 `itunes:key` —— 真实数据都满足，若为 0 说明拿到的不是有效 TTML，打印原始响应前 200 字排查。

- [ ] **Step 6: `bun check` 通过**

---

## Task 7: 编排入口 `fetch.ts`

把「歌名 + 歌手 + 时长」接到上面三个源上，产出本项目 `render.ts` 能用 `Line[]`。

**Files:**
- Create: `src/lyrics/fetch.ts`
- Test: `tools/lyrics-selftest.ts`（追加纯函数部分）

**Interfaces:**
- Consumes: 三个 provider 的 `search*` / `fetch*`，`calculateMatchScoreDetails`
- Produces:
  - `fetchLyrics(query: LyricQuery, options?: FetchLyricsOptions): Promise<FetchLyricsResult>`
  - `type LyricQuery = { title: string; artist?: string; durationSec?: number }`
  - `type FetchLyricsOptions = { sources?: LyricSourceId[]; onLog?: (msg: string) => void }`
  - `type LyricSourceId = 'qq' | 'kugou' | 'amll'`
  - `type FetchLyricsResult = { lines: Line[]; source: LyricSourceId; songName: string; artist: string; isWordByWord: boolean } | null`

- [ ] **Step 1: 写失败的自检（纯函数部分）**

在 `tools/lyrics-selftest.ts` 追加：

```ts
// ── 从音频文件名猜「歌手 - 歌名」
import { parseTrackName } from '../src/lyrics/fetch.ts';
assert.deepEqual(parseTrackName('陈小春 - 街角的晚风'), { artist: '陈小春', title: '街角的晚风' });
assert.deepEqual(parseTrackName('周杰伦-给我一首歌的时间'), { artist: '周杰伦', title: '给我一首歌的时间' });
assert.deepEqual(parseTrackName('只有歌名'), { artist: '', title: '只有歌名' },
  '没有分隔符时整串当歌名，artist 留空');
assert.deepEqual(parseTrackName('A - B - C'), { artist: 'A', title: 'B - C' },
  '只在第一个分隔符处切，歌名里允许有短横');

// ── Folia 的 Line → 本项目的 Line（补上 render.ts 要的 text 字段）
import { toRenderLines } from '../src/lyrics/fetch.ts';
const foliaLines = [{ fullText: '等待换来是够钟', startTime: 12, endTime: 13.6, words: [{ text: '等待', startTime: 12, endTime: 12.5 }] }];
const out = toRenderLines(foliaLines as any);
assert.equal(out[0].text, '等待换来是够钟', 'render.ts 读 l.text ?? l.fullText，补上 text 更稳');
assert.equal(out[0].words[0].startTime, 12);
```

- [ ] **Step 2: 跑，确认失败**

```bash
bun tools/lyrics-selftest.ts
```
Expected: FAIL —— `Cannot find module '../src/lyrics/fetch.ts'`。

- [ ] **Step 3: 写 `src/lyrics/fetch.ts`**

```ts
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

/** 默认顺序：QQ 命中率最高，酷狗次之（和 EchoMusic 同源），AMLL 兜底。 */
const DEFAULT_SOURCES: LyricSourceId[] = ['qq', 'kugou', 'amll'];

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
 */
export function toRenderLines(lines: LyricData['lines']): Line[] {
  return lines.map((l) => ({ ...l, text: l.text ?? l.fullText } as Line));
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
      log(`  在 ${source} 搜索「${query.artist ? `${query.artist} - ` : ''}${query.title}」…`);
      const keyword = query.artist ? `${query.artist} - ${query.title}` : query.title;

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
```

- [ ] **Step 4: 跑自检**

```bash
bun tools/lyrics-selftest.ts
```
Expected: `✓ lyrics-selftest 全部通过`

- [ ] **Step 5: `bun check` 通过**

```bash
bun check
```

**注意**：若 `Line` 类型上没有 `text` 字段（上游 `types.ts` 的 `Line` 确实没有），上面 `toRenderLines` 里的 `as Line` 断言会掩盖问题。**正确做法**是在 `src/lyrics/types.ts` 给 `Line` 补一个可选字段：

```ts
export interface Line {
  // ...上游原有字段
  /** 本项目自有：render.ts 读 l.text ?? l.fullText，补上让两条路径结构一致。 */
  text?: string;
}
```

并在文件头的「改动」注释里记一笔。

---

## Task 8: 接进 CLI

**Files:**
- Modify: `index.ts`（参数解析与分发）
- Modify: `src/render.ts`（或调用处，看歌词从哪进来）

**Interfaces:**
- Consumes: `fetchLyrics` / `parseTrackName`
- Produces: 新增 CLI 选项 `--source <qq|kugou|amll>`、`--no-fetch`

- [ ] **Step 1: 找到歌词加载的位置**

```bash
cd /Users/mr.r/Documents/xgamer/github/renzp94/folia-music-video
grep -n "parseLrc\|guessLrc\|--lrc\|lrc" index.ts | head -30
```

先看清楚现在「歌词从哪来」，再决定插在哪。预期是：CLI 读 `argv` 里的 lrc 路径 → `parseLrc` → 传给 `renderToMp4`。

- [ ] **Step 2: 加两个选项到 `Opts` 与 `parseArgs`**

在 `index.ts` 的 `Opts` interface 里加：

```ts
  /** 歌词源。不给就是 qq → kugou → amll 依次试。 */
  source?: string;
  /** 关掉「找不到歌词文件就联网搜」。 */
  noFetch?: boolean;
```

在 `parseArgs` 里加对应分支（照抄旁边的 `--mode` / `--background` 写法）。

- [ ] **Step 3: 加联网兜底逻辑**

在「歌词文件不存在」的那个分支里，改为：

```ts
// 没有歌词文件时的兜底顺序：同名 .lrc → 联网搜 → 报错
let lines: Line[] = [];
if (lrcPath) {
  lines = parseLrc(readFileSync(lrcPath, 'utf8'), offsetMs).lines;
} else if (!o.noFetch) {
  const { title, artist } = parseTrackName(basename(audioPath, extname(audioPath)));
  const found = await fetchLyrics(
    { title, artist, durationSec: probeDurationSec(audioPath) },
    { onLog: (m) => console.log(m) },
  );
  if (!found) {
    console.error('没找到歌词。可以自己给一份 .lrc，或用 --no-fetch 跳过联网。');
    return 1;
  }
  console.log(`歌词来源：${found.source}  ${found.songName} - ${found.artist}`);
  lines = found.lines;
}
```

`probeDurationSec` 若项目里已有（渲染要算帧数，多半已经用 ffprobe 拿过时长）就复用；没有就传 `undefined` —— `fetchLyrics` 里 `durationSec` 是可选的，只影响打分精度。

- [ ] **Step 4: 手动验证（端到端）**

```bash
cd /Users/mr.r/Documents/xgamer/github/renzp94/folia-music-video
# 先确认：不给 --lrc、且 test/ 下没有同名 lrc 时会走联网
mv "test/陈小春 - 街角的晚风.lrc" /tmp/keep.lrc
bun index.ts "test/陈小春 - 街角的晚风.mp3" --start 40 --duration 8 --out /tmp/lyric-test.mp4
mv /tmp/keep.lrc "test/陈小春 - 街角的晚风.lrc"
```

Expected: 终端打印「歌词来源：qq/kugou ...」以及「逐字/仅行级」，然后正常渲染。

- [ ] **Step 5: 对照验证逐字效果**

用同一段音频渲染两次，一次用原 `.lrc`（行级估算），一次用联网取得的逐字歌词，对比 `/tmp` 下两个 mp4 在同一时间点（比如 1 分 4 秒那句「等待换来是够钟」）的画面。

```bash
bun index.ts "test/陈小春 - 街角的晚风.mp3" --lrc "test/陈小春 - 街角的晚风.lrc" --start 60 --duration 6 --out /tmp/estimated.mp4
bun index.ts "test/陈小春 - 街角的晚风.mp3" --start 60 --duration 6 --out /tmp/wordbyword.mp4
```

Expected: `wordbyword.mp4` 里「是够钟」三个字亮起的时间点，明显比 `estimated.mp4` 更贴合人声。

- [ ] **Step 6: `bun check` 通过**

---

## Task 9: 接进 TUI

**Files:**
- Modify: `src/tui.tsx`

- [ ] **Step 1: 歌词项加「自动获取」选项**

在 `pickLrc` 视图的 `options()` 里，最前面插一项：

```ts
{ key: 'auto', label: '⌕ 自动获取（联网搜索）', color: 'green' },
```

在 `enter()` 的 `pickLrc` 分支里，`picked.key === 'auto'` 时把 `state.lrc` 设为 `null`，并加一个新的 state 标记 `autoLrc: true`。

- [ ] **Step 2: 渲染时走联网分支**

`startRender` 里目前是：

```ts
const lrc = s.lrc ?? (s.audio ? guessLrc(s.audio) : null);
if (!lrc) { setError('还没有选择歌词文件（也没找到同名 .lrc）'); return; }
```

改成：`state.lrc === null && autoLrc` 时改为异步走 `fetchLyrics`，把结果塞进 `lines`；渲染中把联网过程显示在 `RunPanel` 的阶段文案里（`setRun` 的 `label` 字段）。

- [ ] **Step 3: 加一个歌词源选择项**

在设置页（`view === 'settings'`）或主菜单加一项「歌词源」，值 `自动 / QQ / 酷狗 / AMLL`，存进 `src/config.ts`（参照现有的 `ffmpeg` 偏好写法）。

- [ ] **Step 4: 手动验证**

```bash
bun index.ts
```

选一首音频 → 歌词文件选「⌕ 自动获取」→ 开始渲染 → 观察阶段文案里出现「在 qq 搜索…」，随后正常渲染。

- [ ] **Step 5: `bun check` 通过**

---

## Task 10: 网易云源（**已决定跳过**）

> **2026-10-16 决定：本任务不做。** 先交付 QQ + 酷狗 + AMLL 三条腿；网易云的边际收益
> （酷狗已与 EchoMusic 同源）抵不上「多维护一个常驻外部服务」。以下内容保留，供将来真要时参考。

**这一条与前面九条不同，必须先知道它的代价。**

上游的网易云链路（`services/netease.ts` → `neteaseProvider` → `providerRegistry`）依赖 IndexedDB（dexie）、`localStorage`、登录态存储 —— **Bun 里一个都没有**。而且它的歌词接口是**自建的 NeteaseCloudMusicApi 服务**（上游 Electron 版内嵌了 `serveNcmApi`，动态端口）。

所以要用网易云，前提是**你愿意在本机跑一个 NeteaseCloudMusicApi 服务**（或指一个已有的实例），然后：

- [ ] 摘 `services/netease.ts` 的 `getLyric` + `fetchWithCreds` 两个函数（不搬整个文件）
- [ ] base URL 从 `Bun.env.FOLIA_NETEASE_API_BASE` 读，指向那个服务
- [ ] 把 `getApiBase()` 的 Electron 分支（`window.electron.getNeteasePort()`）整段删掉
- [ ] 加进 `src/lyrics/fetch.ts` 的 `LyricSourceId` 与源列表

**建议**：先跳过。QQ + 酷狗 + AMLL 三条腿已经覆盖绝大多数中文歌（实测酷狗/QQ 连通且响应 0.2s 级），网易云的边际收益不足以抵上「多维护一个外部服务」。

---

## 验证

**每个任务的检查点**（本项目无 git，所以不写 commit）：
1. `bun tools/lyrics-selftest.ts` → `✓ 全部通过`
2. `bun check` → 无类型错误

**全部完成后的端到端验收**：
1. `bun tools/lyrics-fetch-check.ts "陈小春 - 街角的晚风"` 能打印逐字时间
2. `bun index.ts "test/陈小春 - 街角的晚风.mp3" --start 60 --duration 6 --out /tmp/a.mp4` 走联网歌词并渲染成功
3. 人工对比：`/tmp/a.mp4` 里「是够钟」的亮起时间比行级估算版更贴合人声（这正是 `docs/TODO.md` 第 1 条记的那个问题）
4. TUI 里选「自动获取」能跑通
5. **打包后仍能用**（这对应「内置到应用中」）：`bun run build:app`，然后直接用 `./dist/folia-video` 跑一次联网取词。
   单文件产物里 `import.meta.url` 指向 `/$bunfs`，本项目在这上面踩过坑（见 README）。
   新的歌词模块只发网络请求、不读磁盘文件，理论上不受影响 —— 但要实测确认，
   尤其是 `opencc-js` 这类带大词表的包在 `--minify` 后是否正常。

---

## 风险与回退

| 风险 | 表现 | 回退 |
|---|---|---|
| 漏改 `/api/lyric-proxy` | 请求打到不存在的相对路径，搜出空结果 | 每个 provider 搬完后 grep 一次 `lyric-proxy\|isElectron`，必须无输出 |
| import 路径没改全 | `bun check` 报找不到模块 | Task 2 Step 4 / Task 4 Step 3 的 `grep "\.\./"` 检查 |
| AMLL 解析 0 行 | `lines.length === 0` | AMLL 的 TTML 每个 `<p>` 必须带 `itunes:key`；先打印原始响应确认拿到的是 TTML |
| 某首歌拿不到 QRC/KRC | `isWordByWord=false` | 换源（顺序里下一个）；歌词本身就没有逐字版时无解，只能落回估算 |
| `opencc-js` 体积大 | 打包产物变大 | 它是 `matchScore` 做简繁归一的。若体积敏感，可换成一张小的简繁映射表 |
| 上游更新后两边漂移 | 移植文件与上游不一致 | 每个文件头的来源注释记了 commit（`7db1ad56`），要同步时按注释里的路径 diff |
| 网易云那条腿跑不起来 | 见 Task 10 | 默认不做 |

## 不做

- **不搬** `autoMatchBestLyric.ts`（多源编排，我们用自己的 30 行 `fetch.ts`）
- **不搬** `neteaseProvider.ts` / `providerRegistry.ts` / `providerStorage.ts` / `services/db.ts`
- **不搬** `workerClient.ts`（`new Worker` 在 `bun build --compile` 的单文件产物里路径会失效；它只服务 netease，而 netease 本轮不做）
- **不搬** 任何 React 组件、store、i18n、设置界面
- **不动** `src/lrc.ts` —— 离线文件路径继续用，两条路并存
