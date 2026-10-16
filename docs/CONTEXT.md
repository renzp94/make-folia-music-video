# Folia 歌词页 → 视频导出工具

> 这份文档是新会话的上下文交接。目标、已验证的事实、方案、坑，都在这里。

## 目标

把 **EchoMusic 的 Folia 歌词页**（`echo-plugins/echo-folia-plugin` 提供的皮肤）渲染成
**MP4 视频**，一首歌一个文件。

**不是录屏。** 用户明确要的是「用代码算出来」，要的是可批量、可定分辨率、帧率稳定的成品，
不是守着屏幕录。

## 为什么不做成插件

2026-10-15 查证过，插件沙箱干不了这件事，四条硬限制：

| 限制 | 证据 |
|---|---|
| 插件 `ctx` 无捕获 API | `app.asar` 里 `capturePage`/`desktopCapturer`/`getDisplayMedia`/`MediaRecorder` 全部零命中；只暴露 `windows`/`ui`/`fs`/`storage`/`audio`/`electron` |
| 歌词是 DOM，不是 canvas | `canvas.captureStream()` 只能录 canvas，DOM 文字录不到 |
| 逐帧截图太慢 | 主进程 `capturePage` 每帧 ~30ms，追不上 60fps，音画会漂 |
| 音频流拿不到 | 播放引擎的音频在 native addon（主进程侧），插件够不着 |

**所以走离线渲染**——画面自己算，不需要任何捕获能力。

## Phase 0 已验证（2026-10-15，跑通了）

无头 Chromium 加载 bundle 并渲染出一帧，**成功**。截图见 `docs/frame0.png`：背景的 mesh
着色器、歌词文字、传进去的配色，全部正常。

验证过的技术点：

| 步骤 | 结果 |
|---|---|
| Playwright 用**系统 Chrome**（`channel: 'chrome'`），不下载浏览器 | ✓ |
| 加载协议**必须是 HTTP**——`file://` 下 ES module 被 CORS 拦，`setContent`（about:blank）下 `localStorage` 抛 SecurityError | ✓ |
| 直接 `import('./visualizer.js')` 拿到导出面 | ✓ |
| `mountVisualizer(root, props)` 挂载 | ✓ |
| 背景着色器初始化（root 里出现 2 个 canvas） | ✓ |

bundle 的导出面（`visualizer.js`）：

```
mountVisualizer  unmountVisualizer  createSilentAudio  motionValue
applyVisualizerTuning  withBackgroundTuning  getTuningSettingsKey
FoliaModePanel  FoliaBackgroundPanel  FoliaBackgroundQuickControls
mountModePanel  mountBackgroundPanel  mountBackgroundQuickControls ...
```

渲染一帧用的最小 props（`tools/render1.mjs` 里有完整版）：

```js
{
  mode: 'classic',                                  // 视觉模式
  currentTime: mod.motionValue(2.0),                // MotionValue，不是数字
  currentLineIndex: 0,
  lines: [{ startTime, endTime, fullText, words: [...] }, ...],   // Folia 的 Line 结构
  theme: { name, backgroundColor, primaryColor, accentColor, secondaryColor,
           fontStyle: 'sans', animationIntensity: 'normal' },
  audioPower: audio.audioPower,                     // MotionValue，0..255
  audioBands: audio.audioBands,                     // { bass, lowMid, mid, vocal, treble, spectrum }
  background: { mode: 'latent' },                   // 背景模式
  paused: false, staticMode: false, isDaylight: false,
  seed: 'xxx', coverUrl: null, showText: true,
  onLyricLineSeek: () => {},
}
```

## 待做的三块

### 1. 离线频谱（中等）

现在传的是 `createSilentAudio()` 的全零值。要真实律动，需要：

- 拿音频文件 → `OfflineAudioContext` 离线跑 → 每帧的 FFT
- 关键：**EchoMusic 给的 `bins` 是「dB 归一化到 0..1」**（不是线性幅度），
  且它的 `binCount` 上限是 **512**、频率是**对数刻度**
- Folia 侧的行为：`audioBands.*` 是 `pow(x/255, boost) * 255`（boost 1.5~3），
  `audioBands.spectrum` 是 1024 个**线性刻度** bin（每 bin 21.5Hz）
- `echo-plugins/echo-folia-plugin/index.js` 的 `startSpectrum()` 里有完整的换算逻辑，
  包括 `resampleLinearSpectrum`（对数 → 线性 1024）和安静段 ×255 ≈ 16 与上游
  `noiseFloor` 吻合这个标定依据。**照抄那份逻辑即可**

### 2. 确定性帧推进（**最难**）

背景有自己基于 `requestAnimationFrame` 的动画循环（`LatentBackground.tsx` 的
`updateAudioResponse`），歌词有 framer-motion。要让画面**精确停在某一帧**：

- 首选：Playwright 的 **fake clock**（`page.clock`）接管 `requestAnimationFrame` /
  `performance.now`，再逐帧 `clock.runFor(1000/fps)` + 手动推进 `currentTime`
- 备选：改 bundle 或注入 patch，把 rAF 换成可控的驱动
- 需要实测哪种可靠。**这是整个项目成败的关键点，先做这个再谈其它**

### 3. 编码（简单）

帧序列 → `ffmpeg` 合成 mp4（原音频直接 `-i audio.flac` 混入）。ffmpeg 本机已有
（`/opt/homebrew/bin/ffmpeg`）。

## 环境

| | |
|---|---|
| Node | v24.8.0 |
| Playwright | 1.64.1（已装；**用 `channel: 'chrome'` 免下载浏览器**） |
| ffmpeg | `/opt/homebrew/bin/ffmpeg` |
| bundle | `../echo-plugins/echo-folia-plugin/folia/visualizer.js`（约 9.8MB，自包含 ESM） |
| 上游源码 | `../folia-major`（bundle 源码在 `echo-folia-plugin` 分支的 `src/visualizer-bundle/`） |

## 待用户确认（新会话先问清）

1. **形态**：命令行工具？还是给个简单界面？
2. **输入**：音频文件 + LRC？还是从 EchoMusic 库里挑歌？
3. **效果**：固定某个模式（如隐现 + 流体），还是要能选？
4. **规格**：分辨率 / 帧率（1080p60？4K30？）

## 已知的坑（别再踩）

- **`file://` 加载 ES module 会被 CORS 拦**，必须起 HTTP 服务
- **`page.setContent()` 是 about:blank origin**，`localStorage` 抛 SecurityError
- **Playwright 默认要下载浏览器**，用 `channel: 'chrome'` 走系统 Chrome
- `currentTime` / `audioPower` / `audioBands.*` 都是 **MotionValue**（用 `mod.motionValue(n)` 造），
  传数字会在 `.get()` 上炸
