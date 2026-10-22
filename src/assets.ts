// 把渲染页面的三个文件内嵌进可执行文件。
//
// `with { type: 'file' }` 让打包器把它们当**资源**而不是模块：源码运行时 import 得到
// 真实路径，`bun build --compile` 后得到 /$bunfs 里的虚拟路径 —— 两种形态下
// `Bun.file()` 都能直接读，所以 serveStatic 不必区分自己在哪种形态里。
//
// 之所以要内嵌：visualizer.js 有 9.8 MB，是渲染的全部视觉逻辑。若靠磁盘上的 site/
// 目录，可执行文件就不是单文件了（还得带着一个目录走）。
import indexHtml from '../site/index.html' with { type: 'file' };
import visualizerJs from '../site/visualizer.js' with { type: 'file' };
import visualizerCss from '../site/visualizer.css' with { type: 'file' };

/** URL 路径 → 资源定位。 */
export const EMBEDDED_SITE: Record<string, string> = {
  // bun-types 把 `*.html` import 的类型定为 HTMLBundle，但 `with { type: 'file' }`
  // 在源码运行与打包后拿到的都是**路径字符串**，故按 string 处理。
  '/index.html': indexHtml as unknown as string,
  '/visualizer.js': visualizerJs,
  '/visualizer.css': visualizerCss,
};

// ffmpeg 静态二进制。用户机器上没有 ffmpeg 时用它兜底，这样打包产物换个机器也能直接用。
//
// 具体拿哪一份由 package.json 的 `imports` 映射决定：默认 darwin-arm64，
// 构建 Windows 版时加 `--conditions=win32` 换成 win32-x64（见 build:win）。
// 这样产物里**只**会嵌入当前目标平台的那一份，不会两份都塞进去。
//
// 注意它不是「资源」而是「可执行文件」：打包后 import 得到的是 /$bunfs 下的虚拟路径，
// **不能直接 spawn**，必须先落盘、给执行权限，见 render.ts 的 resolveFfmpeg()。
import ffmpegBin from '#ffmpeg-bin' with { type: 'file' };
export const EMBEDDED_FFMPEG = ffmpegBin as unknown as string;

/**
 * 内置 ffmpeg 的版本号，用来在启动界面上和用户自己那份做对比。
 * 构建时写死 —— 运行时去 `-version` 问它得先把几十 MB 释放到磁盘，只为显示一行字不值当。
 * 换了 vendor/ffmpeg/ 里的二进制时记得同步这里。
 */
export const EMBEDDED_FFMPEG_VERSION = process.platform === 'win32' ? '6.1.1' : '9.0';
