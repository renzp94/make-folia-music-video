// 诊断：同一个 Chrome 里连续推进时间，看 bundle 画出来的主歌词是否跟随 currentLineIndex
import { launchChrome, connectCdp, killChrome } from '../src/cdp.ts';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, writeFileSync, mkdirSync } from 'node:fs';

/** CDP Runtime.evaluate 的返回（只用到这两个字段）。 */
type EvalReply = { result?: { value?: unknown } };
/** CDP Page.captureScreenshot 的返回（只用到 data）。 */
type ShotReply = { data: string };

const here = dirname(fileURLToPath(import.meta.url));
const siteDir = join(here, '..', 'site');
const srv = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch(req) {
  const p = join(siteDir, new URL(req.url).pathname);
  if (!existsSync(p)) return new Response('404', { status: 404 });
  return new Response(Bun.file(p));
}});

const lines = [
  { text:'雨淋湿了天空', fullText:'雨淋湿了天空', startTime:1, endTime:4, words:[{text:'雨淋湿了天空',startTime:1,endTime:4}] },
  { text:'灰得像哭过',   fullText:'灰得像哭过',   startTime:4, endTime:7, words:[{text:'灰得像哭过',startTime:4,endTime:7}] },
  { text:'你说把爱放下', fullText:'你说把爱放下', startTime:7, endTime:11, words:[{text:'你说把爱放下',startTime:7,endTime:11}] },
];
const findIdx = (t: number) => { let lo=0, hi=lines.length-1, f=-1; while(lo<=hi){const m=(lo+hi)>>1; if(lines[m].startTime<=t){f=m;lo=m+1}else hi=m-1;} return f; };

const browser = await launchChrome({ width: 1280, height: 720 });
const { send, close } = await connectCdp(browser);
await send('Page.enable'); await send('Runtime.enable');
await send('Emulation.setDeviceMetricsOverride', { width:1280, height:720, deviceScaleFactor:1, mobile:false });
await send('Page.addScriptToEvaluateOnNewDocument', { source: `
(()=>{let now=0;const cbs=new Map();let id=1;
globalThis.__frame={tick(ms){now=ms;for(const[k,cb]of[...cbs.entries()]){if(!cbs.has(k))continue;cbs.delete(k);try{cb(ms)}catch(e){}} }};
globalThis.requestAnimationFrame=cb=>{const i=id++;cbs.set(i,cb);return i};
globalThis.cancelAnimationFrame=i=>cbs.delete(i);
const T0=1700000000000; Date.now=()=>T0+now; performance.now=()=>now;})();` });
await send('Page.navigate', { url: `${srv.url}/index.html` });
for (let i=0;i<200;i++){ const r=await send('Runtime.evaluate',{expression:'document.readyState',returnByValue:true}) as EvalReply; if(r.result?.value==='complete')break; await new Promise(x=>setTimeout(x,50)); }

await send('Runtime.evaluate', { expression: `(async()=>{
  const mod = await import('./visualizer.js');
  const audio = mod.createSilentAudio();
  const t = mod.motionValue(0);
  globalThis.__mount = { mod, audio, t };
  globalThis.__props = { mode:'classic', currentTime:t, currentLineIndex:0,
    lines:${JSON.stringify(lines)},
    theme:{name:'Folia',backgroundColor:'#29292b',primaryColor:'#f4f4f5',accentColor:'#f4f4f5',secondaryColor:'#71717a',fontStyle:'sans',animationIntensity:'normal'},
    audioPower:audio.audioPower, audioBands:audio.audioBands, background:{mode:'latent'},
    paused:false, staticMode:false, isDaylight:false, seed:'d', coverUrl:null, showText:true, onLyricLineSeek:()=>{} };
  mod.mountVisualizer(document.getElementById('root'), globalThis.__props);
  return 'ok';})()`, awaitPromise: true });
await new Promise(r=>setTimeout(r,1500));

mkdirSync('/tmp/diag', { recursive: true });
console.log('方案 A：只推进 currentTime，不重挂（看 bundle 是否自己跟行）');
for (const t of [2, 5, 8]) {
  await send('Runtime.evaluate', { expression: `(()=>{const{m,t}=globalThis.__mount;t.set(${t});globalThis.__frame.tick(${t*1000});return 1})()`, returnByValue: true });
  await new Promise(r=>setTimeout(r,250));
  const s = await send('Page.captureScreenshot', { format: 'jpeg', quality:90 }) as ShotReply;
  writeFileSync(`/tmp/diag/A-${t}s.jpg`, Buffer.from(s.data,'base64'));
  const dom = await send('Runtime.evaluate', { expression: `[...document.querySelectorAll('[class*=lyricLine],[class*=lyricMainLine]')].map(e=>e.textContent).filter(Boolean).slice(0,4).join(' | ')`, returnByValue: true }) as EvalReply;
  console.log(`  t=${t}s  DOM 里的歌词: ${dom.result?.value ?? '(取不到)'}`);
}
console.log();
console.log('方案 B：每帧重挂并传 currentLineIndex');
await send('Runtime.evaluate', { expression: `globalThis.__lineIdx=-2; globalThis.__setLine=(idx)=>{ if(idx===globalThis.__lineIdx)return; globalThis.__lineIdx=idx; globalThis.__props.currentLineIndex=idx; globalThis.__mount.mod.mountVisualizer(document.getElementById('root'), globalThis.__props); };`, returnByValue: true });
for (const t of [2, 5, 8]) {
  await send('Runtime.evaluate', { expression: `(()=>{const{m,t}=globalThis.__mount;t.set(${t});globalThis.__frame.tick(${t*1000});globalThis.__setLine(${findIdx(t)});return 1})()`, returnByValue: true });
  await new Promise(r=>setTimeout(r,250));
  const s = await send('Page.captureScreenshot', { format: 'jpeg', quality:90 }) as ShotReply;
  writeFileSync(`/tmp/diag/B-${t}s.jpg`, Buffer.from(s.data,'base64'));
  const dom = await send('Runtime.evaluate', { expression: `[...document.querySelectorAll('[class*=lyricLine],[class*=lyricMainLine]')].map(e=>e.textContent).filter(Boolean).slice(0,4).join(' | ')`, returnByValue: true }) as EvalReply;
  console.log(`  t=${t}s  DOM 里的歌词: ${dom.result?.value ?? '(取不到)'}`);
}
close(); killChrome(browser); srv.stop(true);
