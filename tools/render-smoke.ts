import { renderToMp4 } from '../src/render.ts';
import type { Line } from '../src/lrc.ts';
import { mkdirSync } from 'node:fs';

mkdirSync('/tmp/folia-out', { recursive: true });
const lines = [
  { text: '雨淋湿了天空', startTime: 0.5, endTime: 2.5, words: [
      { text: '雨淋湿了', startTime: 0.5, endTime: 1.5 },
      { text: '天空', startTime: 1.5, endTime: 2.5 } ] },
  { text: '灰得像哭过', startTime: 2.8, endTime: 4.8, words: [
      { text: '灰得像', startTime: 2.8, endTime: 3.8 },
      { text: '哭过', startTime: 3.8, endTime: 4.8 } ] },
];

const t0 = Date.now();
const r = await renderToMp4({
  audioPath: '/tmp/test-music.wav',
  lines: lines as Line[],
  output: '/tmp/folia-out/smoke.mp4',
  siteDir: new URL('../site', import.meta.url).pathname,
  render: { width: 1280, height: 720, fps: 30, mode: 'classic', background: 'latent' },
  onProgress: (p) => process.stdout.write(`\r  渲染进度 ${(p * 100).toFixed(0)}%   `),
});
console.log();
console.log(`✓ 完成: ${r.output}`);
console.log(`  帧数 ${r.frames}，耗时 ${r.seconds.toFixed(1)}s（${(r.frames / r.seconds).toFixed(1)} fps 渲染速度）`);
