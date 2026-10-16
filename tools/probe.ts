// @ts-expect-error playwright 已移除，本脚本是 CDP 直连之前的早期版本，仅作历史参考
import { chromium } from 'playwright';
const browser = await chromium.launch({ channel: 'chrome' }).catch(() => chromium.launch());
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
page.on('pageerror', (e: unknown) => console.log('  [页面错误]', String(e).slice(0, 200)));
page.on('console', (m: { type(): string; text(): string }) => { if (m.type() === 'error') console.log('  [console]', m.text().slice(0, 160)); });

await page.goto('http://127.0.0.1:8791/index.html', { waitUntil: 'load' });
console.log('① 页面加载完成');

// 从已加载的模块里拿导出面：直接再 import 一次同源文件
const info = await page.evaluate(async () => {
  try {
    // @ts-expect-error 页面 bundle，仅在浏览器里可解析
    const m = await import('./visualizer.js');
    return { ok: true, keys: Object.keys(m) };
  } catch (e) { return { ok: false, error: String(e) }; }
});
console.log('② 导入 bundle:', info.ok ? '成功 ✓' : '失败');
console.log('   导出面:', (info.keys || []).join(', '));
if (!info.ok) { console.log('   错误:', info.error.slice(0, 300)); await browser.close(); process.exit(1); }
await browser.close();
