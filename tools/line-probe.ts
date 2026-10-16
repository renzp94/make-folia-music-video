// 验证 updateVisualizer 是否真的能更新画面。
//
// 关键前提：探针必须**逐帧**推进（和 src/stitch.mjs 的 renderRange 一致）。
// 只调一次 __frame.tick() 相当于整个动画只跑了一帧，Framer Motion 的
// exit/enter 永远收敛不了，旧行元素会一直留在 DOM 里 —— 上一版探针
// （tools/update-probe.mjs）就是这么把自己骗了的。
import { launchChrome, connectCdp, killChrome } from '../src/cdp.ts';
import { join, dirname } from 'node:path';
import { existsSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** CDP Runtime.evaluate 的返回（只用到这两个字段）。 */
type EvalReply = { result?: { value?: unknown } };
/** CDP Page.captureScreenshot 的返回（只用到 data）。 */
type ShotReply = { data: string };

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

const browser = await launchChrome({ width: 1280, height: 720 });
const { send, close } = await connectCdp(browser);
await send('Page.enable'); await send('Runtime.enable');
await send('Emulation.setDeviceMetricsOverride', { width:1280, height:720, deviceScaleFactor:1, mobile:false });
await send('Page.addScriptToEvaluateOnNewDocument', { source: `
(()=>{let now=0;const cbs=new Map();let id=1;
globalThis.__frame={tick(ms){now=ms;for(const[k,cb]of[...cbs.entries()]){if(!cbs.has(k))continue;cbs.delete(k);try{cb(ms)}catch(e){}} }};
globalThis.requestAnimationFrame=cb=>{const i=id++;cbs.set(i,cb);return i};
globalThis.cancelAnimationFrame=i=>cbs.delete(i);
const T0=1700000000000; Date.now=()=>T0+now; performance.now=()=>now;
globalThis.__errs=[];
window.addEventListener('error', e=>globalThis.__errs.push(String(e.message||e.error)));
window.addEventListener('unhandledrejection', e=>globalThis.__errs.push('rej:'+String(e.reason)));
// React 的渲染异常走 console.error，不是 window 事件 —— 不 hook 就完全看不见。
for (const k of ['error','warn']) {
  const orig = console[k].bind(console);
  console[k] = (...a)=>{ try{ globalThis.__errs.push(k+':'+a.map(x=>String(x && x.stack || x)).join(' ').slice(0,400)); }catch{} orig(...a); };
}
})();` });
await send('Page.navigate', { url: `${srv.url}/index.html` });
for (let i=0;i<200;i++){const r=await send('Runtime.evaluate',{expression:'document.readyState',returnByValue:true}) as EvalReply;if(r.result?.value==='complete')break;await new Promise(x=>setTimeout(x,50));}

// 基线截图：挂载之前。用来区分「画面来自渲染」还是「来自残影」。
{
  const s = await send('Page.captureScreenshot', { format:'png' }) as ShotReply;
  writeFileSync('/tmp/probe-baseline.png', Buffer.from(s.data,'base64'));
}

const setup = await send('Runtime.evaluate', { expression: `(async()=>{
  const mod = await import('./visualizer.js');
  const audio = mod.createSilentAudio();
  const t = mod.motionValue(0);
  globalThis.__mount={mod,audio,t};
  globalThis.__props={mode:'classic',currentTime:t,currentLineIndex:-1,lines:${JSON.stringify(lines)},
    theme:{name:'Folia',backgroundColor:'#29292b',primaryColor:'#f4f4f5',accentColor:'#f4f4f5',secondaryColor:'#71717a',fontStyle:'sans',animationIntensity:'normal'},
    audioPower:audio.audioPower,audioBands:audio.audioBands,background:{mode:'latent'},
    paused:false,staticMode:false,isDaylight:false,seed:'u',coverUrl:null,showText:true,onLyricLineSeek:()=>{}};
  // 只推进时间，不碰 props —— 与换行分开，才能判断是谁把画面弄没的。
  globalThis.__drive=(toFrame)=>{
    const {t}=globalThis.__mount;
    let f = globalThis.__f ?? 0;
    for (; f<=toFrame; f++) { t.set(f/60); globalThis.__frame.tick(f/60*1000); }
    globalThis.__f = f;
  };
  globalThis.__line=(idx)=>{
    const {mod} = globalThis.__mount;   // 字段名是 mod，不是 m —— 写错这行曾让整轮验证都在测一个 undefined
    globalThis.__props = {...globalThis.__props, currentLineIndex: idx};
    mod.updateVisualizer(globalThis.__props);
    const p0 = globalThis.__props;
    return 'idx='+p0.currentLineIndex+' lines='+(p0.lines||[]).length
      +' line0='+JSON.stringify((p0.lines||[])[idx]||null).slice(0,60)
      +' fn='+typeof mod.updateVisualizer+' showText='+p0.showText;
  };
  mod.mountVisualizer(document.getElementById('root'), globalThis.__props);
  return 'ok';})()`, awaitPromise: true, returnByValue: true }) as EvalReply;
console.log('挂载:', setup.result?.value);

// 关键对照：mount 之后什么都不做，只等真实时间。用来区分
// 「mount 本身不渲染」和「后面的 __drive 同步循环把 React 卡住了」。
await new Promise(r=>setTimeout(r,1500));
{
  const r = await send('Runtime.evaluate', { expression: `(()=>{const el=document.getElementById('root');return 'root子='+el.childNodes.length+' body子='+document.body.childNodes.length+' body元素='+document.body.querySelectorAll('*').length+' canvas='+document.querySelectorAll('canvas').length+' errs='+(globalThis.__errs||[]).slice(0,3).join(' ;; ');})()`, returnByValue:true}) as EvalReply;
  console.log('mount 后未 drive:', r.result?.value);
}

const readDom = async () => {
  const r = await send('Runtime.evaluate', { expression: `(()=>{
    const el=document.getElementById('root');
    if(!el) return '(无 root)';
    return '元素'+el.querySelectorAll('*').length+' 文本['+(el.textContent||'').replace(/\s+/g,' ').trim().slice(0,40)+']';
  })()`, returnByValue: true }) as EvalReply;
  return r.result?.value;
};
const shot = async (name: string) => {
  const s = await send('Page.captureScreenshot', { format:'png' }) as ShotReply;
  writeFileSync(`/tmp/probe-${name}.png`, Buffer.from(s.data,'base64'));
};

console.log('\n单点：换行后推进到 t=1.5s，量第一句位置');
{
  await send('Runtime.evaluate', { expression: `globalThis.__line(0)`, returnByValue: true });
  await new Promise(r => setTimeout(r, 1500));
  await send('Runtime.evaluate', { expression: `(()=>{globalThis.__drive(90); return 1})()`, returnByValue: true });
  const r = await send('Runtime.evaluate', { expression: `JSON.stringify((()=>{
    const out=[];
    for (const e of document.getElementById('root').querySelectorAll('.flex.flex-wrap')) {
      const b = e.getBoundingClientRect();
      let inner='';
      for (const c of e.children) {
        const cb=c.getBoundingClientRect();
        inner += ' {x'+Math.round(cb.x)+' w'+Math.round(cb.width)+' op'+getComputedStyle(c).opacity+' "'+(c.textContent||'').trim().slice(0,8)+'"}';
      }
      out.push('row[y'+Math.round(b.y)+']'+inner);
    }
    return {iw:window.innerWidth, rows:out};
  })())`, returnByValue: true }) as EvalReply;
  console.log('  ' + r.result?.value);
  await shot('slot');
}
{
  const expr = `JSON.stringify((()=>{try{
    const tree = (el, d) => {
      if (d > 6) return '';
      let s = '';
      for (const c of el.children) {
        const b = c.getBoundingClientRect();
        const cs = getComputedStyle(c);
        s += '  '.repeat(d) + c.tagName + '.' + String(c.className).split(' ').slice(0,2).join('.')
           + ' [' + Math.round(b.x) + ',' + Math.round(b.y) + ' ' + Math.round(b.width) + 'x' + Math.round(b.height) + ']'
           + ' op' + cs.opacity + (cs.filter !== 'none' ? ' filter' : '')
           + (c.children.length ? '' : ' "' + (c.textContent || '').trim().slice(0, 10) + '"') + '\\n';
        s += tree(c, d + 1);
      }
      return s;
    };
    return { tree: tree(document.getElementById('root'), 1) };
  }catch(e){return {err:String(e && e.message || e)}}})())`;
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true }) as EvalReply;
  const v = JSON.parse(String(r.result?.value || '{}'));
  console.log('\nDOM 结构:\n' + (v.tree || v.err || '(空)'));
}
console.log('\n截图: /tmp/probe-t1.png /tmp/probe-t2.png /tmp/probe-t5.png /tmp/probe-t9.png');
close(); killChrome(browser); srv.stop(true);
