// 测：连续 mount 同一 props（只改 currentLineIndex），组件内部状态是保留还是重置
import { launchChrome, connectCdp, killChrome } from '../src/cdp.ts';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/** CDP Runtime.evaluate 的返回（只用到这两个字段）。 */
type EvalReply = { result?: { value?: unknown } };

const here = dirname(fileURLToPath(import.meta.url));
const siteDir = join(here, '..', 'site');
const srv = Bun.serve({ hostname:'127.0.0.1', port:0, fetch(req){
  const p = join(siteDir, new URL(req.url).pathname);
  return Boolean(Bun.file(p).exists()) ? new Response(Bun.file(p)) : new Response('404',{status:404});
}});
const lines = [
  { text:'第一句', fullText:'第一句', startTime:1, endTime:4, words:[{text:'第一句',startTime:1,endTime:4}] },
  { text:'第二句', fullText:'第二句', startTime:4, endTime:7, words:[{text:'第二句',startTime:4,endTime:7}] },
  { text:'第三句', fullText:'第三句', startTime:7, endTime:11, words:[{text:'第三句',startTime:7,endTime:11}] },
];
const browser = await launchChrome({ width: 960, height: 540 });
const { send, close } = await connectCdp(browser);
await send('Page.enable'); await send('Runtime.enable');
await send('Emulation.setDeviceMetricsOverride', { width:960, height:540, deviceScaleFactor:1, mobile:false });
await send('Page.addScriptToEvaluateOnNewDocument', { source: `
(()=>{let now=0;const cbs=new Map();let id=1;
globalThis.__frame={tick(ms){now=ms;for(const[k,cb]of[...cbs.entries()]){if(!cbs.has(k))continue;cbs.delete(k);try{cb(ms)}catch(e){}} }};
globalThis.requestAnimationFrame=cb=>{const i=id++;cbs.set(i,cb);return i};
globalThis.cancelAnimationFrame=i=>cbs.delete(i);
const T0=1700000000000; Date.now=()=>T0+now; performance.now=()=>now;})();` });
await send('Page.navigate', { url: `${srv.url}/index.html` });
for (let i=0;i<200;i++){const r=await send('Runtime.evaluate',{expression:'document.readyState',returnByValue:true}) as EvalReply;if(r.result?.value==='complete')break;await new Promise(x=>setTimeout(x,50));}

await send('Runtime.evaluate', { expression: `(async()=>{
  const mod = await import('./visualizer.js');
  const audio = mod.createSilentAudio();
  const t = mod.motionValue(0);
  globalThis.__mount={mod,audio,t};
  globalThis.__props={mode:'classic',currentTime:t,currentLineIndex:0,lines:${JSON.stringify(lines)},
    theme:{name:'Folia',backgroundColor:'#29292b',primaryColor:'#f4f4f5',accentColor:'#f4f4f5',secondaryColor:'#71717a',fontStyle:'sans',animationIntensity:'normal'},
    audioPower:audio.audioPower,audioBands:audio.audioBands,background:{mode:'latent'},
    paused:false,staticMode:false,isDaylight:false,seed:'x',coverUrl:null,showText:true,onLyricLineSeek:()=>{}};
  // 记下 React root 里的实例数，观察重挂是否重建
  globalThis.__roots=0;
  mod.mountVisualizer(document.getElementById('root'), globalThis.__props);
  return 'ok';})()`, awaitPromise: true });
await new Promise(r=>setTimeout(r,1200));

// 连续推进 + 重挂，看每次重挂后主歌词是否立刻正确
for (const [t, idx] of [[2,0],[5,1],[9,2]]) {
  await send('Runtime.evaluate', { expression: `(()=>{
    const{m,t}=globalThis.__mount; t.set(${t}); globalThis.__frame.tick(${t*1000});
    globalThis.__props.currentLineIndex=${idx};
    m.mountVisualizer(document.getElementById('root'), globalThis.__props);
    return 1})()`, returnByValue: true });
  await new Promise(r=>setTimeout(r,400));
  const txt = await send('Runtime.evaluate', { expression: `(()=>{
    const el=[...document.querySelectorAll('div,span')].filter(e=>/第一句|第二句|第三句/.test(e.textContent)&&e.children.length===0);
    return el.map(e=>e.textContent.trim()).join(' / ');})()`, returnByValue: true }) as EvalReply;
  console.log(`  t=${t}s 期望第${idx+1}句 → 画面上: ${txt.result?.value || '(空)'}`);
}
close(); killChrome(browser); srv.stop(true);
