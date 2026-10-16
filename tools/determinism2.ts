// 方案 B：把 rAF 换成手动驱动，逐帧喂时间 → 画面应完全确定
/// <reference lib="dom" />
// @ts-expect-error playwright 已移除，本脚本是 CDP 直连之前的早期版本，仅作历史参考
import { chromium } from 'playwright';
import { createHash } from 'node:crypto';

declare global {
  var __frame: { set(ms: number): void; tick(ms: number): void };
}

const W = 1280, H = 720;
const browser = await chromium.launch({ channel: 'chrome' }).catch(() => chromium.launch());

const DRIVER = () => {
  // 页面加载前注入：接管时间源与 rAF
  let fakeNow = 0;
  const cbs = new Map<number, (ms: number) => void>();
  let nextId = 1;
  globalThis.__frame = {
    set(ms) { fakeNow = ms; },
    tick(ms) {
      fakeNow = ms;
      const list = [...cbs.entries()];
      for (const [id, cb] of list) {
        if (!cbs.has(id)) continue;
        cbs.delete(id);
        try { cb(ms); } catch (e) { console.error('rAF 回调抛错', e); }
      }
    },
  };
  const origRAF = globalThis.requestAnimationFrame;
  const g = globalThis as unknown as {
    requestAnimationFrame: (cb: (ms: number) => void) => number;
    cancelAnimationFrame: (id: number) => void;
  };
  g.requestAnimationFrame = (cb) => { const id = nextId++; cbs.set(id, cb); return id; };
  g.cancelAnimationFrame = (id) => { cbs.delete(id); };
  // 冻结时钟：所有基于 Date.now / performance.now 的动画都会停在同一相位
  const T0 = 1700000000000;
  Date.now = () => T0 + fakeNow;
  performance.now = () => fakeNow;
  if (globalThis.performance?.timeOrigin !== undefined) {
    try { Object.defineProperty(performance, 'timeOrigin', { get: () => T0, configurable: true }); } catch {}
  }
};

async function renderAt(t: number, steps: number) {
  const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
  page.on('pageerror', (e: unknown) => console.log('  [错误]', String(e).slice(0, 140)));
  await page.addInitScript(DRIVER);
  await page.goto('http://127.0.0.1:8791/index.html', { waitUntil: 'load' });

  await page.evaluate(async ({ t }: { t: number }) => {
    // @ts-expect-error 页面 bundle，仅在浏览器里可解析
    const mod = await import('./visualizer.js');
    const audio = mod.createSilentAudio();
    mod.mountVisualizer(document.getElementById('root'), {
      mode: 'classic',
      currentTime: mod.motionValue(t),
      currentLineIndex: 0,
      lines: [
        { startTime: 0, endTime: 4, fullText: '雨淋湿了天空', words: [{ text: '雨淋湿了天空', startTime: 0, endTime: 4 }] },
        { startTime: 5, endTime: 9, fullText: '灰得像哭过', words: [{ text: '灰得像哭过', startTime: 5, endTime: 9 }] },
      ],
      theme: { name: 'Folia', backgroundColor: '#29292b', primaryColor: '#f4f4f5', accentColor: '#00cc65', secondaryColor: '#a1a1aa', fontStyle: 'sans', animationIntensity: 'normal' },
      audioPower: audio.audioPower, audioBands: audio.audioBands,
      background: { mode: 'latent' }, paused: false, staticMode: false, isDaylight: false,
      seed: 'det-1', coverUrl: null, showText: true, onLyricLineSeek: () => {},
    });
  }, { t });

  // 逐帧驱动（每帧 16.67ms）
  for (let i = 0; i < steps; i++) {
    await page.evaluate((ms: number) => globalThis.__frame.tick(ms), i * 16.6667);
  }
  // 让 GPU 把这一帧真正画完（读一次像素即可强制同步）
  await page.evaluate(() => new Promise<void>((r) => {
    const c = document.querySelector('canvas');
    if (c) { const g = c.getContext('webgl2') || c.getContext('webgl'); if (g) g.finish?.(); }
    r();
  }));
  const buf = await page.screenshot();
  await page.close();
  return createHash('sha256').update(buf).digest('hex').slice(0, 16);
}

const STEPS = 120;
const a = await renderAt(2.0, STEPS);
const b = await renderAt(2.0, STEPS);
const c = await renderAt(2.0, STEPS);
console.log('手动驱动 rAF，同一时间点三次渲染：');
console.log('  #1', a);
console.log('  #2', b);
console.log('  #3', c);
console.log();
console.log(a === b && b === c
  ? '✓ 完全一致 —— 帧完全可控，「效果最好」的方案成立'
  : '✗ 仍有差异 —— 还有非受控的时间源');
await browser.close();
