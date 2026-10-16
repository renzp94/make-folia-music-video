/**
 * 内嵌的 ffmpeg 可执行文件。
 *
 * `with { type: 'file' }` 让 bun 打包时把这个二进制塞进产物，运行时默认导出的是一段
 * 指向 `/$bunfs` 虚拟路径的字符串 —— **不能直接 spawn**，必须先落盘、加执行位，
 * 见 src/render.ts 的 resolveFfmpeg() / materializeEmbedded()。
 */
declare const path: string;
export default path;
