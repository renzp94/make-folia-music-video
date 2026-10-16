// 验证 updateVisualizer 是否真的能更新画面
import { launchChrome, connectCdp, killChrome } from '../src/cdp.ts';
import { join, dirname } from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** CDP Runtime.evaluate 的返回（只用到这两个字段）。 */
type EvalReply = { result?: { value?: unknown } };

const here = dirname(fileURLToPath(import.meta.url));
const siteDir = join(here, '..', 'site');
const srv = Bun.serve({ hostname:'127.0.0.1', port:0, fetch(req){
  const p = join(siteDir, new URL(req.url).pathname);
  // Bun.file 对不存在的路径会抛 ENOENT 把服务带崩（favicon.ico 就是），必须挡住
  if (!existsSync(p)) return new Response('404', { status: 404 });
  return new Response(Bun.file(p), { headers: { 'Cache-Control': 'no-store' } });
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

const setup = await send('Runtime.evaluate', { expression: `(async()=>{
  // 先看页面到底加载到了什么
  const res = await fetch('./visualizer.js');
  const txt = await res.text();
  const fileInfo = { status: res.status, bytes: txt.length, 文件含update: txt.includes('updateVisualizer') };
  const mod = await import('./visualizer.js');
  const modInfo = { 导出数: Object.keys(mod).length, 含update: 'updateVisualizer' in mod,
                    全部导出: Object.keys(mod).sort().join(',') };
  globalThis.__diag = { fileInfo, modInfo };
  globalThis.__hasUpdate = typeof mod.updateVisualizer === 'function';
  const audio = mod.createSilentAudio();
  const t = mod.motionValue(0);
  globalThis.__mount={mod,audio,t};
  globalThis.__props={mode:'classic',currentTime:t,currentLineIndex:0,lines:${JSON.stringify(lines)},
    theme:{name:'Folia',backgroundColor:'#29292b',primaryColor:'#f4f4f5',accentColor:'#f4f4f5',secondaryColor:'#71717a',fontStyle:'sans',animationIntensity:'normal'},
    audioPower:audio.audioPower,audioBands:audio.audioBands,background:{mode:'latent'},
    paused:false,staticMode:false,isDaylight:false,seed:'u',coverUrl:null,showText:true,onLyricLineSeek:()=>{}};
  mod.mountVisualizer(document.getElementById('root'), globalThis.__props);
  return JSON.stringify({ hasUpdate: globalThis.__hasUpdate, __diag: globalThis.__diag });})()`, awaitPromise: true, returnByValue: true }) as EvalReply;
let info: Record<string, unknown> = {};
try { info = JSON.parse(String(setup.result?.value ?? '{}')); } catch {}
console.log('诊断:', JSON.stringify(info.__diag ?? {}, null, 1));
console.log('updateVisualizer 存在:', info.hasUpdate);
await new Promise(r=>setTimeout(r,1200));

const readLine = async () => {
  const r = await send('Runtime.evaluate', { expression: `(()=>{
    const els=[...document.querySelectorAll('*')].filter(e=>e.children.length===0 && /第一句|第二句|第三句/.test(e.textContent||''));
    // 取字号最大的那个（主歌词）
    let best=null, bestSize=0;
    for (const e of els) { const s=parseFloat(getComputedStyle(e).fontSize)||0; if (s>bestSize){bestSize=s;best=e;} }
    return best ? best.textContent.trim() : '(无)';})()`, returnByValue: true }) as EvalReply;
  return r.result?.value;
};

console.log('\n用 updateVisualizer 换行：');
for (const [t, idx] of [[2,0],[5,1],[9,2]]) {
  await send('Runtime.evaluate', { expression: `(()=>{
    const{m,audio,t}=globalThis.__mount; t.set(${t}); globalThis.__frame.tick(${t*1000});
    globalThis.__props={...globalThis.__props, currentLineIndex:${idx}};
    m.updateVisualizer(globalThis.__props);
    return 1})()`, returnByValue: true });
  await new Promise(r=>setTimeout(r,500));
  console.log(`  t=${t}s 期望第${idx+1}句 → 主歌词: ${await readLine()}`);
}
close(); killChrome(browser); srv.stop(true);
