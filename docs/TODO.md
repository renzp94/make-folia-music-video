# 待办

按优先级排列。每条都写清「为什么现在不做」和「将来怎么下手」，避免下次重新调查一遍。

---

## 1. 逐字歌词（当前只能估算，句内节奏会偏）

**现象**（2026-10-15 用户反馈）：1 分 4 秒「等待换来是够钟」——「是够钟」实际已经唱完，
这三个字才慢慢亮起来。个别的句子有这个问题，不是全篇。

**原因**：手上的 LRC 是**行级**的，只有每句的起点。句内每个字的时刻只能靠
`src/lrc.ts` 的 `buildTimedWords` 按权重均分（中文每字权重 1、标点 0、英文整词 `1+长度×0.15`，
只用 90% 时长留收尾）。人唱歌不会均匀，所以必然有偏差。

具体到这一句：`[01:03.60]等待换来是够钟` → 算法给整句 63.60~67.07（3.47 秒），
「是/够/钟」落在 65.59 / 66.08 / 66.58 —— 实际唱得比这快。

**这不是算法写错了**：`buildTimedWords` 是逐字从 Folia 的
`src/utils/lyrics/parserCore.ts` 移植的，两边完全一致。Folia 拿同一份行级 LRC 也会这样。
差别在于 Folia 通常能从歌词源拿到**逐字**歌词（TTML / 增强 LRC），而我们是离线喂 LRC。

**已验证的路子**：
- AMLL DB（`https://api.amll.dev/v1/lyrics/search?musicName=&artistName=`）—— 这是 Folia 也在用的源，
  但《街角的晚风》在它那里搜不到（`items: []`）。
- `src/lrc.ts` 的 `parseLrc` **已经支持增强 LRC 的逐字标签**（`[mm:ss.xx]<mm:ss.xx>字<...>`），
  所以只要能拿到逐字歌词，直接喂进去就行，不用改解析器。

**将来怎么做**（任选其一）：
1. 接 Folia 的本地 API `http://127.0.0.1:32109/v1/lyric`（返回带 `offset` 和逐字时间轴的歌词，
   前提是 Folia / EchoMusic 的 Folia mod 正在运行）。
2. 接 AMLL / QQ / 网易的歌词源，命中就下 TTML。
3. 提供一个「打轴」辅助：用 `--start/--duration` 抽某句，人工标几个字的时间点，存成增强 LRC。

**验收**：拿一句已知「唱得快」的歌词，渲染后逐帧确认每个字在对应音频位置上亮起。

---

## 2. 并行渲染（已实现，但默认关闭）

**现状**：并行代码在 `src/stitch.ts` 的 `renderFramesParallel` 里，`workers > 1` 才启用。
CLI 默认 `--workers 1`，即**单片**（一个 Chrome 从第 0 帧连续跑到底）。

| 方案 | 速度 | 全长 14398 帧 |
|---|---|---|
| 单片（默认） | 19.7 fps | 13.2 分钟 |
| 4 片并行 | 55.6 fps | 5.5 分钟 |

**为什么默认关**：并行快 2.8 倍，但画面会出错 —— 同一时刻（25s / 120s / 200s）
歌词会糊、错位甚至整句不可见（`maxOp=0`），单片版完全正常。

**已经排除的原因**（都实测过，别再重复查）：
- 不是 GPU 竞争：`workers=2` 一样坏，`workers=1` 但分 5 片**也坏**（串行不影响）。
- 不是 DOM 状态错：诊断显示 `ct` / `line` / `rows` / 文字内容全对，只有合成出来的帧不对。
- 不是分片粒度：每片 500 帧和每片 480 帧都坏。
- 不是 React 没 flush：加过强制 `__resend`，反而让画面更糟（已删）。

**已经做过的改进**（都保留在代码里，对单片也无害）：
- 预热帧也截图（只是丢弃内容）—— 修掉了「每片开头瞎 100 帧」的一部分。
- 换行时先 `currentTime.set` 再 render。
- 退出的行超 2 个就整树重置。

**下一步方向**：
- 根因还没定位。最可疑的是「独立 Chrome 冷启动时，Framer Motion 的动画时钟起点
  和连续播放时不一致」—— 需要在片内比较「预热期动画进度」和「从头连续跑时同一时刻的进度」。
- 判断标准：抽 25s / 120s / 200s，与单片版逐像素比对。
- 另一条路：不切帧，而是**切歌**（把长音频拆成几段独立渲染再拼接），每段都是完整的
  「从 0 开始」，代价是段与段之间的视觉连续性会断。

---

## 3. Windows 版打包

macOS 版已经自包含（内嵌 bundle + ffmpeg）。Windows 版缺一份 **win 的静态 ffmpeg**——
`eugeneware/ffmpeg-static` 的 release 里有（`ffmpeg-win32-x64.gz`，tag `b6.1.1`），
但本机下它时 GitHub 的 HTTP2 连接一直断（`Error in the HTTP2 framing layer`），
试过 `--http1.1` 也没走完。

要做的话：

1. 拿到 `ffmpeg-win32-x64.gz`，解压成 `vendor/ffmpeg/ffmpeg-win32-x64.exe`
   （也可以从 https://www.gyan.dev/ffmpeg/builds/ 下 `ffmpeg-release-essentials.zip`）
2. 同样放一个 `vendor/ffmpeg/ffmpeg-win32-x64.exe.d.ts`
3. 在 `src/assets.ts` 里按平台条件 import —— **注意**：`with { type: 'file' }` 是静态导入，
   两个平台的二进制会**同时**被打进产物（体积 +43 MB × 2）。要避免的话得改成运行时
   从 `Bun.embeddedFiles` 按名字取，或者各平台分别构建。
4. 加回 `build:win` 脚本：`--target=bun-windows-x64 --outfile=dist/folia-video-windows-x64.exe`

**坑**：现在 `EMBEDDED_FFMPEG` 是写死的 darwin 那份。在没有 Windows 二进制的情况下
直接 `--target=bun-windows-x64` 会打出一个**内嵌着 macOS 二进制**的 Windows 程序，
在 Windows 上必然崩 —— 所以 `build:win` 已从 package.json 移除。

---

## 4. HTTP 服务形态（供 EchoMusic 插件 / Folia mod 调用）

用户的目标形态：插件负责提供音源和歌词，这个工具负责渲染。协议草案：
`POST /v1/render`（收音频 + 歌词 + 参数，返回 job id）+ `GET /v1/jobs/:id`（查进度 / 取产物）。
还没实现。

---

## 已解决（仅作索引，细节见 `src/` 里对应位置的注释）

- **TUI**（`src/tui.tsx`，ink + React）：选音频/歌词（支持进目录、`..` 返回、同名 `.lrc` 自动配对）、
  14 种视觉模式、6 种背景、动画强度、720p/1080p/2K/4K 清晰度。非文件项支持 ←→ 直接切换。
- **全项目迁到 TypeScript**，`bun run check`（bun 自带的类型检查）是改完代码的必跑项（bun 只转译不查类型，
  实测靠它抓到过 `c is not defined` 和丢失的类型定义）。
- **site/ 内嵌进可执行文件**（`src/assets.ts` 用 `import ... with { type: 'file' }`），
  `dist/folia-video` 是真正的单文件（78 MB），旁边不需要再带 `site/` 目录。
- **进度显示**：渲染阶段和 ffmpeg 合成阶段都显示「已用时 / 剩余」。

- 换行时 `currentTime` 必须先于 `render` 设置（照 `echo-folia-plugin/index.js:1316-1360` 的 tick 顺序），
  否则新行按上一帧的时间挂载，逐字高亮滞后。
- 退出的歌词行会滞留在 DOM（`AnimatePresence` 的 exit 动画在手动驱动的 rAF 下不收敛），
  累积到 3 行以上就互相叠字 → 累积超 2 行时整树重置。
- Linux/macOS 上 `-movflags +faststart` 必须加，否则 moov 在文件末尾，大文件容易被判成「打不开」。
- 默认 fps 必须是 60：30fps 下逐帧驱动的 spring 动画收敛不够，歌词会卡在模糊的过渡态。
