// 验证：冻结时间后，同一时间点渲染两次是否逐像素一致
/// <reference lib="dom" />
// @ts-expect-error playwright 已移除，本脚本是 CDP 直连之前的早期版本，仅作历史参考
import { chromium } from 'playwright';
import { createHash } from 'node:crypto';

const W = 1280, H = 720;
const browser = await chromium.launch({ channel: 'chrome' }).catch(() => chromium.launch());

async function renderAt(t: number) {
  const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
  page.on('pageerror', (e: unknown) => console.log('  [错误]', String(e).slice(0, 160)));
  // 冻结时间：接管 Date.now / performance.now / rAF
  await page.clock.install({ time: new Date('2026-01-01T00:00:00Z') });
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

  // 推进固定时长（让着色器初始化 + 动画走到确定位置）
  await page.clock.runFor(2000);
  await page.waitForTimeout(900);   // 给 WebGL 一点真实时间画完

  const buf = await page.screenshot();
  await page.close();
  return createHash('sha256').update(buf).digest('hex').slice(0, 16);
}

const a = await renderAt(2.0);
const b = await renderAt(2.0);
const c = await renderAt(2.0);
console.log('同一时间点，三次渲染的截图哈希：');
console.log('  #1', a);
console.log('  #2', b);
console.log('  #3', c);
console.log();
console.log(a === b && b === c
  ? '✓ 完全一致 —— 时间可控，方案成立'
  : '✗ 有差异 —— 存在独立时钟，需要另想办法');
await browser.close();
