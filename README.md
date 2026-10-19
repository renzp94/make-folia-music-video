# folia-music-video

把 Folia 歌词页的视觉效果**离线渲染**成 MP4（一首歌一个文件）。**不是录屏** —— 逐帧驱动 headless Chrome，所以画质不受屏幕和录制软件限制。

复用 `echo-folia-plugin` 的那份 `visualizer.js` bundle，因此和 EchoMusic 歌词页里看到的完全一致。

## 快速开始

```bash
bun install
bun index.ts                    # 无参数 → 进终端界面
```

界面里依次选：音频 → 歌词 → 视觉效果 → 背景效果 → 动画强度 → 清晰度 → ffmpeg，然后**点「开始渲染」**。
↑↓ 或 j/k 移动、Enter 确认、Esc 返回；**歌词**与 **ffmpeg** 这两行可以用 ←→ 直接切换取值；`s` 跳到 ffmpeg 页；`q` 退出（会再问一次，`q` / `y` / Enter 都算确认）。
渲染中 Enter / s / Ctrl-C 停止。

**渲染在界面里跑**，不退出：按钮下方实时显示进度条和「已用时 / 剩余」，按钮自身变成**「停止渲染」**，随时可以中止（中止会清掉半成品文件）。跑完后按钮变回「开始渲染」，并显示产物路径。

「歌词」把联网和本地合成同一份列表，**联网在前、本地兜底压尾** —— 选哪个就是哪个，没有隐式优先级：

- **`⌕ 自动获取（联网搜索）`** —— 按 **酷狗 → QQ → AMLL** 依次试（先拿 ffmpeg 读出音频**真实时长**再搜，时长对不上会选错歌）；
- **`⌕ 联网 · 酷狗音乐 / QQ 音乐 / AMLL`** —— 只用某一个源；
- **`本地（兜底：用与音频同名的 .lrc）`** —— 用同名 `.lrc`；这一项下面就是目录导航与具体的 `.lrc`，选一个等于显式指定那份文件。

联网那几秒会在同一个进度面板里逐条显示搜索过程（`在 kugou 搜索「…」`），期间按 Enter / s / Ctrl-C 可以取消。
选过的来源会记住（`~/.config/folia-video/config.json` 里的 `lyricChoice`），下次启动接着用。

## 命令行

```bash
bun index.ts <音频> [歌词.lrc] [选项]
```

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
| `--workers <n>` | 并行 Chrome 数（默认 1＝单片）。**>1 目前会出画面问题**，见下 |
| `--site <目录>` | bundle 所在目录（默认用内嵌的那份） |
| `--source <源>` | 歌词源 `qq`\|`kugou`\|`amll`（默认按这个顺序依次试） |
| `--no-fetch` | 找不到歌词文件时不要联网搜，直接报错 |

视觉效果可选值（14 个）：`classic` `partita` `cadenza` `fume` `monet` `cappella` `tilt` `claddagh` `pendolo` `sonnet` `tempera` `lumiere` `diorama` `still`

背景可选值（6 个）：`latent` `common` `monet` `nomand` `sora` `url`

不传第二个参数时，先找与音频同名的 `.lrc`；**没有就连网上 QQ / 酷狗 / AMLL 搜一遍**（按此顺序，`--source` 可指定单个源，`--no-fetch` 可关掉）。搜出来的往往是逐字歌词，比行级 `.lrc` 估算的逐字效果更准。

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
bun run build:app          # → dist/folia-video（约 122 MB，当前平台）
bun run build:mac          # → dist/folia-video-macos-arm64（交叉编译，在 Mac 上出 macOS 版）
./dist/folia-video
```

产物是**自包含**的，拷到别的机器上直接能跑，不用装任何东西：

- **bundle**（9.8 MB 的 `visualizer.js` + HTML/CSS）内嵌在里面，不用另带 `site/` 目录。
  `serveStatic` 的优先级是磁盘 > 内嵌，所以开发时重建了 bundle 会立即生效、不必重新打包。
- **ffmpeg**（43 MB 静态构建）也内嵌了。运行时优先用 `PATH` 里的；没有才把内嵌的那份
  释放到临时目录再执行（`/$bunfs` 里的虚拟文件不能直接 spawn，必须先落盘加执行位）。

Windows 版还没做 —— 需要一份 win 的静态 ffmpeg，做法见 `docs/TODO.md`。

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
src/cdp.ts          极简 CDP 客户端
src/spectrum.ts     离线 FFT（对齐 Folia 的 analyser 参数）
src/lrc.ts          LRC / 增强 LRC 解析
src/assets.ts       bundle 内嵌声明
site/               渲染页面 + visualizer bundle
tools/              开发期的探针与自检脚本（未随主程序迁移到 TS）
```

## 已知限制

- **并行渲染（`--workers > 1`）画面会出错** —— 快 2.8 倍（5.5 分钟 vs 13.2 分钟），但部分时间点歌词会糊、错位甚至整句不可见。原因是每个分片都是冷启动的独立 Chrome，动画状态重建不回来。排查过程和已排除的原因记在 `docs/TODO.md` 第 2 条。
- **逐字歌词只能估算** —— 手头的 LRC 多为行级（只有每句起点），句内每个字的时刻按权重均分，而人唱得不均匀，所以个别句子会「字慢半拍」。要精准得有逐字歌词（增强 LRC / TTML）。见 `docs/TODO.md` 第 1 条。
- **单文件可执行程序 78 MB** —— 大部分是内嵌的 bundle 和 React/ink 运行时。

其余待办见 **`docs/TODO.md`**，历史背景见 **`docs/CONTEXT.md`**。
