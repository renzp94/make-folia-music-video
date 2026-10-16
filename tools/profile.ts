// 拆解逐帧耗时：evaluate / screenshot / 写盘 各占多少
import { launchChrome, connectCdp, killChrome } from '../src/cdp.ts';
import { computeSpectrumFrames } from '../src/spectrum.ts';
import { spawn, type SpawnOptions } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';

/** CDP Runtime.evaluate 的返回（只用到这两个字段）。 */
type EvalReply = { result?: { value?: unknown } };
/** CDP Page.captureScreenshot 的返回（只用到 data）。 */
type ShotReply = { data: string };

const here = dirname(fileURLToPath(import.meta.url));
const siteDir = join(here, '..', 'site');

// PCM
// stdout 是 Node spawn 的简写选项，运行时支持，但 @types/node 的 SpawnOptions 未声明，故断言
const r = spawn('ffmpeg', ['-v','error','-i','/tmp/test-music.wav','-f','f32le','-ac','1','-ar','44100','-'], { stdout: 'pipe' } as SpawnOptions);
const chunks: Buffer[] = []; r.stdout!.on('data', c => chunks.push(c));
await new Promise(res => r.on('close', res));
const buf = Buffer.concat(chunks);
const samples = new Float32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
const frames = computeSpectrumFrames(samples, 44100, 30, 0.6);

const { createServer } = await import('node:http');
const { readFileSync, existsSync } = await import('node:fs');
const srv = createServer((req, res) => {
  const p = join(siteDir, req.url!.split('?')[0]);
  if (!existsSync(p)) { res.writeHead(404); return res.end(); }
  res.writeHead(200); res.end(readFileSync(p));
});
await new Promise<void>(r2 => srv.listen(0, '127.0.0.1', r2));
const url = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;

const browser = await launchChrome({ width: 1280, height: 720 });
const { send, close } = await connectCdp(browser);
await send('Page.enable'); await send('Runtime.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 720, deviceScaleFactor: 1, mobile: false });
await send('Page.navigate', { url: `${url}/index.html` });
for (let i = 0; i < 100; i++) {
  const s = await send('Runtime.evaluate', { expression: 'document.readyState', returnByValue: true }) as EvalReply;
  if (s.result?.value === 'complete') break;
  await new Promise(x => setTimeout(x, 100));
}
await send('Runtime.evaluate', { expression: `(async () => {
  const mod = await import('./visualizer.js');
  const audio = mod.createSilentAudio();
  globalThis.__mount = { mod, audio, t: mod.motionValue(0) };
})()`, awaitPromise: true });

const out = '/tmp/prof'; mkdirSync(out, { recursive: true });
let tEval = 0, tShot = 0, tWrite = 0;
const N = 40;
for (let f = 0; f < N; f++) {
  const t = f / 30;
  let a = Date.now();
  await send('Runtime.evaluate', { expression: `(()=>{const{a,t}=globalThis.__mount;t.set(${t});a.audioPower.set(${100});globalThis.__frame&&globalThis.__frame.tick(${t*1000});return 1})()`, returnByValue: true });
  tEval += Date.now() - a;

  a = Date.now();
  const shot = await send('Page.captureScreenshot', { format: 'png' }) as ShotReply;
  tShot += Date.now() - a;

  a = Date.now();
  writeFileSync(join(out, `f${f}.png`), Buffer.from(shot.data, 'base64'));
  tWrite += Date.now() - a;
}
console.log(`总帧数 ${N}`);
console.log(`  evaluate  : ${tEval}ms  (${(tEval/N).toFixed(1)}ms/帧)`);
console.log(`  截图       : ${tShot}ms  (${(tShot/N).toFixed(1)}ms/帧)`);
console.log(`  写盘       : ${tWrite}ms  (${(tWrite/N).toFixed(1)}ms/帧)`);
console.log(`  合计       : ${tEval+tShot+tWrite}ms  → ${(N/((tEval+tShot+tWrite)/1000)).toFixed(1)} fps`);
close(); killChrome(browser); srv.close();
