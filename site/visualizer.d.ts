// bun 的 `with { type: 'file' }` 资源导入：源码运行时得到真实路径字符串。
// TS 对 `.js` 导入会先做扩展名替换，于是本声明优先于旁边 9.8 MB 的 visualizer.js，
// 避免去解析那个 bundle（见 src/assets.ts）。
declare const path: string;
export default path;
