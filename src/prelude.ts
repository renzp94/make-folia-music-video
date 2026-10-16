// 必须在 ink 被加载之前执行，所以单独放一个模块、由入口静态 import。
//
// 背景：ink 的 reconciler 在 `process.env.DEV === 'true'` 时会去
// `import.meta.resolve('react-devtools-core')` 并 `import('./devtools.js')` ——
// 那是 ink 自己开发时用的可选依赖，我们没装。打进单文件可执行产物后它就变成
// 运行时报「Cannot find package 'react-devtools-core'」。
//
// 注意不能把 `delete process.env.DEV` 直接写在入口文件的顶层：打包器会把入口的
// 顶层语句排在所有依赖之后，等它跑到时 ink 的模块体早就执行过了（实测如此）。
// 放进一个被 import 的模块里，就会随依赖顺序在 ink 之前执行。
//
// prelude —— 本模块只有下面这一行副作用，保持原样。
delete process.env.DEV;
