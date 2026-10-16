// 资源导入（`with { type: 'file' }`）的 ambient 声明。
//
// bun 在源码运行时把这些 import 求值成**真实路径字符串**，`bun build --compile`
// 后求值成 /$bunfs 里的虚拟路径 —— 两种形态下都是 string。TS 不认 .css 这类
// 非模块扩展名，声明成 string 即可（见 src/assets.ts）。.html 由 bun-types 自带声明
// （类型是 HTMLBundle，与 file 导入的实际值不符），故在 assets.ts 里单独转回 string。
declare module '*.css' {
  const path: string;
  export default path;
}
