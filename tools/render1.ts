/// <reference lib="dom" />
// @ts-expect-error playwright 已移除，本脚本是 CDP 直连之前的早期版本，仅作历史参考
import { chromium } from 'playwright';
const browser = await chromium.launch({ channel: 'chrome' }).catch(() => chromium.launch());
const page = await browser.newPage({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });
page.on('pageerror', (e: unknown) => console.log('  [页面错误]', String(e).slice(0, 240)));
page.on('console', (m: { type(): string; text(): string }) => { if (m.type() === 'error') console.log('  [console]', m.text().slice(0, 200)); });

await page.goto('http://127.0.0.1:8791/index.html', { waitUntil: 'load' });

const result = await page.evaluate(async () => {
  try {
    // @ts-expect-error 页面 bundle，仅在浏览器里可解析
    const mod = await import('./visualizer.js');
    const audio = mod.createSilentAudio();
    // 造一段歌词
    const lines = [
      { startTime: 0, endTime: 4, fullText: '雨淋湿了天空', words: [{ text: '雨淋湿了天空', startTime: 0, endTime: 4 }] },
      { startTime: 5, endTime: 9, fullText: '灰得像哭过', words: [{ text: '灰得像哭过', startTime: 5, endTime: 9 }] },
    ];
    const theme = {
      name: 'Folia', backgroundColor: '#29292b', primaryColor: '#f4f4f5',
      accentColor: '#00cc65', secondaryColor: '#a1a1aa',
      fontStyle: 'sans', animationIntensity: 'normal',
    };
    const props = {
      mode: 'classic',
      currentTime: mod.motionValue(2.0),
      currentLineIndex: 0,
      lines,
      theme,
      audioPower: audio.audioPower,
      audioBands: audio.audioBands,
      background: { mode: 'latent' },
      visualizerTunings: undefined,
      paused: false,
      staticMode: false,
      isDaylight: false,
      seed: 'probe-1',
      coverUrl: null,
      showText: true,
      onLyricLineSeek: () => {},
    };
    mod.mountVisualizer(document.getElementById('root'), props);
    return { ok: true };
  } catch (e) { return { ok: false, error: String(e) + '\n' + ((e as { stack?: string }).stack || '').split('\n').slice(0, 4).join('\n') }; }
});

console.log('③ 挂载:', result.ok ? '成功 ✓' : '失败');
if (!result.ok) { console.log(result.error); await browser.close(); process.exit(1); }

// 等渲染稳定（背景着色器要初始化）
await page.waitForTimeout(2500);
const rootHTML = await page.evaluate(() => document.getElementById('root')!.innerHTML.slice(0, 300));
console.log('④ root 内容长度:', rootHTML.length, rootHTML.length > 50 ? '（有内容 ✓）' : '（空 ✗）');
console.log('   canvas 数量:', await page.evaluate(() => document.querySelectorAll('canvas').length));

await page.screenshot({ path: '/tmp/folia-render/frame0.png' });
console.log('⑤ 已截图 → /tmp/folia-render/frame0.png');
await browser.close();
