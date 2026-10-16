// 验证：AudioContext + suspend 能否逐帧取到 analyser 的频谱
/// <reference lib="dom" />
// @ts-expect-error playwright 已移除，本脚本是 CDP 直连之前的早期版本，仅作历史参考
import { chromium } from 'playwright';
const browser = await chromium.launch({ channel: 'chrome' }).catch(() => chromium.launch());
const page = await browser.newPage({ viewport: { width: 400, height: 300 } });
page.on('pageerror', (e: unknown) => console.log('  [错误]', String(e).slice(0, 200)));
await page.goto('http://127.0.0.1:8791/index.html', { waitUntil: 'load' });

const r = await page.evaluate(async () => {
  const res = await fetch('./test-tone.wav');
  const buf = await res.arrayBuffer();
  const ctx = new AudioContext({ sampleRate: 44100 });
  const audio = await ctx.decodeAudioData(buf);
  const src = ctx.createBufferSource();
  src.buffer = audio;
  const an = ctx.createAnalyser();
  an.fftSize = 2048;
  an.smoothingTimeConstant = 0.6;
  src.connect(an); an.connect(ctx.destination);
  const data = new Uint8Array(an.frequencyBinCount);

  const out = [];
  src.start();
  for (const t of [0.2, 0.4, 0.6, 0.8]) {
    await (ctx.suspend as (when: number) => Promise<void>)(t);
    an.getByteFrequencyData(data);
    // 取几个位置看有没有信号
    out.push({ t, s0: data[0], s10: data[10], s20: data[20], max: Math.max(...data) });
    await ctx.resume();
  }
  await ctx.close();
  return out;
});
console.log('suspend 逐帧取频谱：');
for (const x of r) console.log(`  t=${x.t}  bin0=${x.s0}  bin10=${x.s10}  bin20=${x.s20}  max=${x.max}`);
const anySignal = r.some((x: { max: number }) => x.max > 0);
console.log();
console.log(anySignal ? '✓ 取到了信号，AudioContext + suspend 可行' : '✗ 全是 0 —— suspend 时 analyser 不保留数据');
await browser.close();
