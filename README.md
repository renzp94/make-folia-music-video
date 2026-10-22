<p align="center">
  <img src="assets/logo-256.png" width="120" alt="make-folia-music-video">
</p>

# make-folia-music-video

把 Folia 歌词页的视觉效果**离线渲染**成 MP4，一首歌一个文件。

**不是录屏**：逐帧驱动 headless Chrome 推进动画，画质由渲染参数决定，不受屏幕分辨率和录制软件限制。
视觉部分复用 Folia 的 `visualizer.js` bundle，输出与歌词页所见一致；音频、歌词、ffmpeg 全部在本地完成。

支持 macOS 与 Windows，可打包成带内置 ffmpeg 的单个可执行文件。

## 快速开始

需要 [Bun](https://bun.sh) 和本机的 Chrome / Edge（渲染时驱动它）；ffmpeg 可选，没有就用内置的那份。

```bash
bun install
bun start                       # 无参数 → 进终端界面
```

界面里依次选：音频 → 歌词 → 视觉效果 → 背景效果 → 动画强度 → 清晰度 → 并行 → ffmpeg，然后**点「开始渲染」**。
↑↓ 或 j/k 移动、Enter 确认、Esc 返回；**歌词**、**并行**与 **ffmpeg** 这三行可以用 ←→ 直接切换取值；`s` 跳到 ffmpeg 页；`q` 退出（会再问一次，`q` / `y` / Enter 都算确认）。
音频列表里用**空格多选**（`[x]` 标记），选多首会按「并行」设置同时渲染；单首内部仍是一个 Chrome 从第 0 帧连续跑到结尾。
渲染中：多首会**逐首显示进度条**，`↑↓` 选中任务、`Enter` 只停选中那首，`a` / `Ctrl-C` 全部停止；单首时 Enter / s / Ctrl-C 停止。

**渲染在界面里跑**，不退出：按钮下方实时显示进度条和「已用时 / 剩余」，按钮自身变成**「停止渲染」**，随时可以中止（中止会清掉半成品文件）。跑完后按钮变回「开始渲染」，并显示产物路径。

「歌词」把联网和本地合成同一份列表，**联网在前、本地兜底压尾** —— 选哪个就是哪个，没有隐式优先级：

- **`⌕ 自动获取（联网搜索）`** —— 按 **酷狗 → QQ → AMLL** 依次试（先拿 ffmpeg 读出音频**真实时长**再搜，时长对不上会选错歌）；
- **`⌕ 联网 · 酷狗音乐 / QQ 音乐 / AMLL`** —— 只用某一个源；
- **`本地（兜底：用与音频同名的 .lrc）`** —— 用同名 `.lrc`；这一项下面就是目录导航与具体的 `.lrc`，选一个等于显式指定那份文件。

联网那几秒会在同一个进度面板里逐条显示搜索过程（`在 kugou 搜索「…」`），期间按 Enter / s / Ctrl-C 可以取消。
选过的来源会记住（`~/.config/make-folia-video/config.json` 里的 `lyricChoice`），下次启动接着用。

## 命令行

```bash
bun index.ts <音频...> [选项]
```

`<音频...>` 可以给多首：每首各自找同名 `.lrc`（没有就联网搜），按 `--jobs` 同时渲染。
多首时不能用 `--out`，也不能显式指定 `.lrc`（歌词本来就无法共用）。

| 选项 | 说明 |
|---|---|
| `--out <路径>` | 输出 mp4（默认与音频同名，放在当前目录） |
| `--width` / `--height` | 分辨率（默认 1920×1080） |
| `--fps <n>` | 帧率（默认 60）。**别降到 30** —— 逐帧驱动的动画会收敛不够，歌词卡在过渡态 |
| `--mode <名称>` | 视觉效果（默认 `classic`） |
| `--background <名称>` | 背景（默认 `latent`） |
| `--intensity <名称>` | 动画强度 `normal`\|`chaotic`\|`calm`（默认 `normal`） |
| `--offset <毫秒>` | 歌词整体偏移，**正值＝歌词提前**（与 Folia 的 `lyricTimelineOffsetMs` 同向） |
| `--start <秒>` / `--duration <秒>` | 只渲染一小段。调效果时用它，几十秒出结果，不用等整首 |
| `--crf <n>` | H.264 质量，越小画质越好文件越大（默认 16） |
| `--jobs <n>` | 同时渲染几首（1–6，默认 3） |
| `--site <目录>` | bundle 所在目录（默认用内嵌的那份） |
| `--source <源>` | 歌词源 `qq`\|`kugou`\|`amll`（默认按这个顺序依次试） |
| `--no-fetch` | 找不到歌词文件时不要联网搜，直接报错 |

视觉效果可选值（14 个）：`classic` `partita` `cadenza` `fume` `monet` `cappella` `tilt` `claddagh` `pendolo` `sonnet` `tempera` `lumiere` `diorama` `still`

背景可选值（6 个）：`latent` `common` `monet` `nomand` `sora` `url`

不显式指定 `.lrc` 时，先找与音频同名的 `.lrc`；**没有就连网上 QQ / 酷狗 / AMLL 搜一遍**（按此顺序，`--source` 可指定单个源，`--no-fetch` 可关掉）。搜出来的往往是逐字歌词，比行级 `.lrc` 估算的逐字效果更准。

例子：

```bash
# 整首
bun index.ts "local-test/陈小春 - 街角的晚风.mp3"

# 只渲 20-28 秒，试效果
bun index.ts "local-test/陈小春 - 街角的晚风.mp3" --start 20 --duration 8 --out /tmp/try.mp4

# 歌词慢了半秒
bun index.ts song.mp3 --offset -500
```

## 打成单文件可执行程序

```bash
bun run build              # 依次产出 macOS + Windows 两个包
bun run build:mac          # → dist/make-folia-video-macos-arm64（交叉编译，在 Mac 上出 macOS 版）
bun run build:win          # → dist/make-folia-video-windows-x64.exe（交叉编译，在 Mac 上出 Windows 版）
./dist/make-folia-video-macos-arm64
# Windows: dist\make-folia-video-windows-x64.exe
```

产物是**自包含**的，拷到别的机器上直接能跑，不用装 Bun、ffmpeg，也不用带 `site/` 目录：

- **bundle**（9.8 MB 的 `visualizer.js` + HTML/CSS）内嵌在里面，不用另带 `site/` 目录。
  `serveStatic` 的优先级是磁盘 > 内嵌，所以开发时重建了 bundle 会立即生效、不必重新打包。
- **ffmpeg**（macOS 50 MB / Windows 79 MB 静态构建）也内嵌了。运行时优先用 `PATH` 里的；
  没有才把内嵌的那份释放到临时目录再执行（`/$bunfs` 里的虚拟文件不能直接 spawn，必须先落盘加执行位）。
  构建时按目标平台只嵌入对应那一份（`package.json` 的 `#ffmpeg-bin` 映射 + `--conditions=win32`）。

Windows 版同样自包含，但**渲染仍然依赖本机的 Chrome 或 Edge**（和 macOS 版一样，只是换了个可执行文件）；
找不到时可以用 `CHROME_PATH` 指定。

> ⚠️ 改完 `src/` 后**必须重新 build**。`dist/` 里是打包那一刻的静态快照，不会自动跟着源码变 ——
> 拿旧产物测新功能，会以为是代码没写对。

## 开发

```bash
bun run check            # bun 自带的类型检查 —— 改完代码必跑
bun run start            # 等价于 bun index.ts
```

**`bun run check` 不是可选项**：bun 只转译、不做类型检查，实测靠它抓到过 `c is not defined` 这类运行时才炸的错误。它是 bun 1.4 起自带的（`bun check`），比 `tsc --noEmit` 快一个数量级（约 90ms 对几秒），所以不必额外跑 tsc。

目录：

```
index.ts            入口：CLI 参数解析 + TUI 分发
src/tui.tsx         终端界面（ink + React）
src/render.ts       渲染主流程（频谱 → 逐帧 → ffmpeg 合成）
src/stitch.ts       逐帧驱动 headless Chrome（CDP）
src/batch.ts        多首渲染的并发调度
src/cdp.ts          极简 CDP 客户端
src/spectrum.ts     离线 FFT（对齐 Folia 的 analyser 参数）
src/lrc.ts          LRC / 增强 LRC 解析
src/assets.ts       bundle 与内置 ffmpeg 的内嵌声明
vendor/ffmpeg/      内嵌的静态 ffmpeg（darwin / win32）
site/               渲染页面 + visualizer bundle
tools/              开发期的探针与自检脚本（未随主程序迁移到 TS）
```

## 已知限制

- **单首内部不切帧并行** —— 动画状态是历史依赖的（Framer Motion 的 WAAPI 动画、行切换、整树 reset），从中间时刻起跑的独立 Chrome 无法可靠重建状态，实测会糊、错位、整句不可见。所以每首仍由一个 Chrome 从第 0 帧连续跑到底；要提速就一次给多首，用 `--jobs` 并行。
- **逐字歌词只能估算** —— 手头的 LRC 多为行级（只有每句起点），句内每个字的时刻按权重均分，而人唱得不均匀，所以个别句子会「字慢半拍」。要精准得有逐字歌词（增强 LRC / TTML）。
- **单文件可执行程序 130 MB（macOS）/ 184 MB（Windows）** —— 大部分是内嵌的 ffmpeg、bundle 和 React/ink 运行时。
