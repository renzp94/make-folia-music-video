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
const withWords = data.lines.find((l: any) => l.words.length > 1);
if (withWords) {
  console.log(`逐字样例「${withWords.fullText}」：`);
  for (const w of withWords.words.slice(0, 5)) {
    console.log(`    「${w.text}」 ${w.startTime.toFixed(2)}~${w.endTime.toFixed(2)}s`);
  }
}
