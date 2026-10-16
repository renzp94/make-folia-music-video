// PNG / JPEG / WebP 截图耗时对比
import { launchChrome, connectCdp, killChrome } from '../src/cdp.ts';
import { spawn } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import type { AddressInfo } from 'node:net';

const here = dirname(fileURLToPath(import.meta.url));
const siteDir = join(here, '..', 'site');
const srv = createServer((req, res) => {
  const p = join(siteDir, req.url!.split('?')[0]);
  if (!existsSync(p)) { res.writeHead(404); return res.end(); }
  res.writeHead(200); res.end(readFileSync(p));
});
await new Promise<void>(r => srv.listen(0, '127.0.0.1', r));
const url = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;

const browser = await launchChrome({ width: 1920, height: 1080 });
const { send, close } = await connectCdp(browser);
await send('Page.enable'); await send('Runtime.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 1920, height: 1080, deviceScaleFactor: 1, mobile: false });
await send('Page.navigate', { url: `${url}/index.html` });
for (let i = 0; i < 100; i++) {
  const s = await send('Runtime.evaluate', { expression: 'document.readyState', returnByValue: true }) as { result?: { value?: unknown } };
  if (s.result?.value === 'complete') break;
  await new Promise(x => setTimeout(x, 100));
}
await send('Runtime.evaluate', { expression: `(async()=>{const m=await import('./visualizer.js');const a=m.createSilentAudio();globalThis.__mount={m,a,t:m.motionValue(0)};
  globalThis.__props={mode:'classic',currentTime:globalThis.__mount.t,currentLineIndex:0,lines:[{startTime:0,endTime:99,fullText:'测试歌词',words:[{text:'测试歌词',startTime:0,endTime:99}]}],theme:{name:'Folia',backgroundColor:'#29292b',primaryColor:'#f4f4f5',accentColor:'#f4f4f5',secondaryColor:'#71717a',fontStyle:'sans',animationIntensity:'normal'},audioPower:a.audioPower,audioBands:a.audioBands,background:{mode:'latent'},paused:false,staticMode:false,isDaylight:false,seed:'b',coverUrl:null,showText:true,onLyricLineSeek:()=>{}};
  m.mountVisualizer(document.getElementById('root'),globalThis.__props);})()`, awaitPromise: true });
await new Promise(r => setTimeout(r, 1200));

const N = 25;
for (const fmt of ['png', 'jpeg', 'webp']) {
  const opts: { format: string; quality?: number } = { format: fmt };
  if (fmt === 'jpeg') opts.quality = 95;
  if (fmt === 'webp') opts.quality = 100;
  // 预热
  await send('Page.captureScreenshot', opts);
  const t0 = Date.now();
  let bytes = 0;
  for (let i = 0; i < N; i++) {
    await send('Runtime.evaluate', { expression: `globalThis.__frame?globalThis.__frame.tick(${i * 33}):1`, returnByValue: true });
    const s = await send('Page.captureScreenshot', opts) as { data: string };
    bytes += s.data.length * 0.75;
  }
  const ms = Date.now() - t0;
  console.log(`  ${fmt.padEnd(6)} ${(ms / N).toFixed(1)}ms/帧   ${(N / (ms / 1000)).toFixed(1)} fps   均 ${(bytes / N / 1024).toFixed(0)} KB`);
}
close(); killChrome(browser); srv.close();
