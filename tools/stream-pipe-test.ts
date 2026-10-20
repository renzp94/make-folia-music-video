// 流式管道的行为断言。跑法：bun tools/stream-pipe-test.ts
//
// 测的是「渲染过程中不落盘」这个新行为，以及产物仍然正确。
// 落盘版本会写 14398 个 jpg（一整首约 4~6 GB），这个测试守住「不再产生它们」。
import assert from 'node:assert/strict';
import { readdirSync, existsSync, rmSync, statSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { spawn } from 'node:child_process';
import { renderToMp4 } from '../src/render.ts';
import { parseLrc } from '../src/lrc.ts';
import { readFileSync } from 'node:fs';

const AUDIO = 'local-test/陈小春 - 街角的晚风.mp3';
const LRC = 'local-test/陈小春 - 街角的晚风.lrc';
const OUT = '/tmp/stream-pipe-test.mp4';
const CLIP = '/tmp/stream-pipe-test-clip.mp3';

if (!existsSync(AUDIO)) {
  console.log(`跳过：找不到测试素材 ${AUDIO}（local-test/ 不入版本控制）`);
  process.exit(0);
}

// 只截 10 秒来测 —— 断言的是「落不落盘」，与时长无关；
// 整首歌要渲 5400 帧（数分钟），没必要。
const clip = spawn('ffmpeg', ['-v', 'error', '-y', '-ss', '60', '-t', '10', '-i', AUDIO, CLIP],
  { stdio: ['ignore', 'ignore', 'inherit'] });
await new Promise((res) => clip.on('close', res));

rmSync(OUT, { force: true });
const outDir = dirname(OUT);
const framesDirs = () => readdirSync(outDir).filter((n) => n.startsWith('.frames-'));

// 渲染前应当是干净的
const before = new Set(framesDirs());

// 渲染期间反复抽查：只要出现新的 .frames-* 目录，就说明还在落盘
let sawFramesDuringRender = false;
const probe = setInterval(() => {
  for (const n of framesDirs()) if (!before.has(n)) sawFramesDuringRender = true;
}, 100);

const lines = parseLrc(readFileSync(LRC, 'utf8'), 0).lines;

let result;
try {
  result = await renderToMp4({
    audioPath: CLIP, lines, output: OUT, siteDir: '',
    render: { width: 640, height: 360, fps: 30 },
    onStage: () => {},
  });
} finally {
  clearInterval(probe);
}

// ── 断言 1（新行为）：渲染全程没有产生帧文件
assert.equal(sawFramesDuringRender, false,
  '渲染过程中磁盘上出现了 .frames-* 目录 —— 说明帧仍在落盘');

// ── 断言 2（旧行为不能坏）：产物存在且大小合理
assert.ok(statSync(OUT).size > 10_000, `产物太小：${statSync(OUT).size} 字节`);

// ── 断言 3（旧行为不能坏）：产物帧数与预期一致
// 项目里没有 ffprobe，用 ffmpeg 解码一遍从 stderr 的 stats 里读 frame=。
// 注意别加 `-v error` —— 那会把 stats 行一起压掉，什么也抓不到。
const probeOut = spawn('ffmpeg', ['-i', OUT, '-f', 'null', '-'],
  { stdio: ['ignore', 'ignore', 'pipe'] });
let ffErr = '';
probeOut.stderr.on('data', (c: Buffer) => { ffErr += c.toString(); });
await new Promise((res) => probeOut.on('close', res));
// ffmpeg 的 stats 是**每秒一行**，`frame=` 会出现很多次 —— 要取最后一次的累计值
const hits = [...ffErr.matchAll(/frame=\s*(\d+)/g)];
const last = hits.at(-1);
assert.ok(last, `ffmpeg 没能报告帧数，stderr：${ffErr.slice(0, 200)}`);
assert.equal(Number(last![1]), result.frames,
  `产物帧数不符：期望 ${result.frames}，实际 ${last![1]}`);

// ── 断言 4（收尾）：跑完也不该留下帧目录
const leftover = framesDirs().filter((n) => !before.has(n));
assert.deepEqual(leftover, [], '渲染结束后残留了 .frames-* 目录');

const sizeMb = (statSync(OUT).size / 1e6).toFixed(1);
rmSync(OUT, { force: true });
rmSync(CLIP, { force: true });
console.log(`✓ stream-pipe-test 全部通过（${result.frames} 帧，产物 ${sizeMb}MB —— 已删）`);
