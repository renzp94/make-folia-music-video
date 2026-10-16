import { parseLrc } from '../src/lrc.ts';
import assert from 'node:assert/strict';

const plain = parseLrc(`[ti:测试]
[ar:某人]
[offset:-500]
[00:01.00]第一句
[00:03.50]第二句更长一点`);
assert.equal(plain.meta.ti, '测试');
assert.equal(plain.lines.length, 2);
// offset 的符号：正值＝歌词提前（时间戳减去它），与 LRC 标准和 Folia 的
// lyricTimelineOffsetMs 同向。所以 [offset:-500] 是把歌词整体往后推 0.5 秒。
assert.equal(plain.lines[0].startTime, 1.5, 'offset -500ms → 歌词延后 0.5 秒');
assert.equal(plain.lines[1].startTime, 4.0);
assert.equal(plain.lines[0].words.length, 3, '3 个字 → 3 个逐字');

const ahead = parseLrc(`[offset:1000]\n[00:10.00]第一句`);
assert.equal(ahead.lines[0].startTime, 9.0, 'offset +1000ms → 歌词提前 1 秒');

// --offset 参数是在 LRC 自带 offset 之上再叠加一层
const layered = parseLrc(`[offset:-500]\n[00:10.00]第一句`, 1000);
assert.equal(layered.lines[0].startTime, 9.5, 'LRC offset 与外部 --offset 叠加');

const word = parseLrc(`[00:10.00]<00:10.00>你<00:11.00>好<00:12.00>世界`);
assert.equal(word.lines[0].fullText, '你好世界');
assert.deepEqual(word.lines[0].words.map(w=>[w.text,w.startTime]),
  [['你',10],['好',11],['世界',12]], '逐字标签应被采用');

const multi = parseLrc(`[00:05.00][00:20.00]副歌`);
assert.equal(multi.lines.length, 2, '同一句两个时间标签');

console.log('✓ LRC 解析：逐行 / 逐字 / offset / 重复标签 全部通过');
