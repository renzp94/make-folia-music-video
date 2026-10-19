# 渲染管线改进分析（参照 Folia 的实现）

**写于 2026-10-16，同日补充实测数据。**

> **本文经历过一次自我推翻。** 初版根据 Folia 的注释**推测**了几条优化方向（内存管道、流水线、
> 反节流），并在 §八 标注「没有验证」。当天下午做了实测，**其中一半被证伪**（见 §五）。
> 保留这个过程的记录，因为「从上游注释推出来的优化方向」本身就是个值得警惕的方法。

**结论摘要**：

- Folia 有一条和本项目**目标完全一致**的「离线逐帧渲染成视频」路径，且**驱动方式和我们相同**（合成时钟 + 逐帧驱动页面）。差别在取帧与编码。
- **实测**：每帧 68.9ms 里，`Page.captureScreenshot` 占 **95%**（65.7ms），其余全部加起来不到 3ms。
- 那 65.7ms 里，**JPEG 编码约 17ms，「渲染 + 合成」约 48ms** —— 后者是**不可压缩**的。
- **18.7 fps 就是这个视觉（WebGL 着色器 + DOM 动画）在 1080p 下的渲染速度**，不是我们代码路径的锅。
- 唯一能省下接近 20ms 的开关（`--disable-gpu`）会让 **WebGL 背景完全消失**，不可用。
- **⇒ 想更快只有并行；同等保真度下并行的唯一路线是「切段」（每段从 0 开始）。**

---

## 一、Folia 有两条导出路径

| | **路径 A：实时录制** | **路径 B：离线逐帧** |
|---|---|---|
| 入口 | Remote Control 面板（需配对遥控才显示） | mod API `api.render.exportVideo(spec)` |
| 代码 | `src/services/electronVideoExport.ts`<br>`src/hooks/useElectronVideoExportController.ts` | `electron/modSystem/exportService.cjs`<br>`src/mods/export/modExportPage.tsx` |
| 做法 | 录正在播放的窗口 | 合成时钟逐帧驱动 + 截图 + ffmpeg |
| 速度 | 实时（等于歌长） | 比实时快（离线加速） |
| **对标** | ✗ 不是我们要的 | ✅ **这就是我们的对标** |

**注意**：两条都不是普通 UI 功能。路径 A 藏在「远程控制」面板里，路径 B 是 mod API（`docs/folium/api.md:1224`）。所以在官方软件界面上找不到「导出视频」是正常的 —— 它没有做成菜单项。

**路径 B 代码里的自我描述**（`exportService.cjs:1-7`）：

> `Off-screen transparent-window renderer that drives the in-app visualizer on a **synthetic clock** and **pipes per-frame captures into ffmpeg** to produce a MOV with an alpha channel. The window is shown but parked off-screen so the compositor/rAF run at full speed while staying invisible to the user.`

---

## 二、路径 B 的六个关键做法

### 1. 合成时钟驱动页面（和我们的一致）

`src/mods/export/modExportPage.tsx:96-104`：

```js
const renderFrame = useCallback(async (tSec: number) => {
    currentTimeRef.current.set(tSec);
    applyLineIndex(tSec);
    // One animation frame is enough: RAF-driven engines (particles, pixi,
    // canvas loops) advance one step, then capturePage forces the
    // compositor to produce the resulting frame synchronously. Waiting for
    // extra settle frames only multiplies export time.
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
}, [applyLineIndex]);
```

**关键认知**：`capturePage` 会**强制合成器同步产出这一帧**，所以只需要等一个 rAF。
（我们的 `DRIVER_SRC` 做的是同一件事 —— 接管 rAF、`Date.now`、`performance.now`，见 `src/stitch.ts`。）

### 2. 取帧用 `capturePage`，拿的是原始位图

`exportService.cjs:335-343`：

```js
let image = await exportWindow.webContents.capturePage();
if (!image || image.isEmpty()) throw new Error('export-capture-empty');
const bitmap = Buffer.from(image.getBitmap());     // ← 原始 RGBA / BGRA
```

**它不读 WebGL 帧缓冲** —— 全仓没有 `gl.readPixels`、没有 Pixi 的 `renderer.extract`。`capturePage` 抓的是 **Chromium 合成后的整页位图**，WebGL canvas 和 DOM 文字一视同仁。这一点和我们用 `Page.captureScreenshot` 是同一层面。

### 3. 原始像素直接进 ffmpeg，零中间编码

`exportService.cjs:194-218`：

```js
// Raw-pixel pipe instead of PNG frames: skipping per-frame PNG
// compression/decode removes the biggest synchronous CPU cost in the
// main process (the UI jank source) and speeds the whole export up.
const rawPixelFormat = process.platform === 'darwin' ? 'rgba' : 'bgra';
const ffmpegArgs = [..., '-f', 'rawvideo', '-pixel_format', rawPixelFormat,
                    '-video_size', `${width}x${height}`, '-i', 'pipe:0', ...];
```

**它明说 PNG 编解码是「主进程里最大的一笔同步 CPU 开销」。** 但见 §五 —— 在我们的链路上，这一项只值 17ms，不是大头。

### 4. 流水线：写上一帧与渲染下一帧重叠

`exportService.cjs:328-376`（要点）：

```js
let writeTail = Promise.resolve();
for (let frame = 0; frame < totalFrames; frame += 1) {
    let image = await exportWindow.webContents.capturePage();
    // Kick off the next frame's render before blocking on stdin so
    // its RAF settle overlaps this frame's pipe drain.
    const nextRender = frame + 1 < totalFrames ? renderFrame(exportWindow, nextT) : null;
    await writeTail;
    writeTail = writeToStdin(ffmpegProcess, bitmap);
    if (nextRender) await nextRender;
}
```

**它注释里点明**：两个慢步骤是「合成器 settle」和「stdin 排空」，靠重叠把它们并行掉。

### 5. 窗口要 shown 但停到屏幕外

`exportService.cjs:252-279`：

```js
exportWindow = new BrowserWindow({
    // A shown window keeps GPU compositing and rAF running at full
    // speed (a `show:false` window throttles rAF and falls back to a
    // slow software readback on capturePage).
    show: true, x: -32000, y: -32000,
```

### 6. 音频不参与离线导出

`modExportPage.tsx:42-48`：全 0 的 `STATIC_AUDIO_BANDS` + `audioPower` 恒 0。离线渲染只跟时间轴走，频谱是预先算好的。

**其他限制**（`exportService.cjs:22`）：`maxDurationSec = 15*60`、fps 10–60、尺寸 320×180 ~ 3840×2160；alpha 只有 Windows 保证。

---

## 三、我们现在的实现

`src/stitch.ts` 的逐帧循环本身没变 —— 每帧仍是「设时间 → 驱动 rAF → 截图」：

```js
if (b.lineIndex !== sentLine) {
  await evaluate(send, `globalThis.__setLine(${b.lineIndex}, ${timeSec})`);   // 换行时，含 await 50ms
  sentLine = b.lineIndex;
}
await evaluate(send, `(() => { t.set(); audio.*.set(); __frame.tick(); })()`);  // 每帧
const shot = await send('Page.captureScreenshot', { format: 'jpeg', quality }); // 每帧
```

**变的是帧的去向。** 2026-10-19 起按 worker 数分成两条路：

| | **单片（`workers <= 1`，默认）** | **多片（`workers > 1`）** |
|---|---|---|
| 帧的去向 | **流式管道**：`ffmpeg -f image2pipe -i pipe:0` | 落盘成 `f%06d.jpg` |
| 中间帧 | **0 字节** | 14398 个 jpg，约 4~6 GB |
| 内存 | 1~2 帧（`write()` 返回 false 就等 `drain`） | 1 帧 |
| 顺序保证 | 单条流天然有序 | 靠文件名序号 |

**为什么多片必须落盘**：分片各自渲染、各自写文件，ffmpeg 才能按 `f%06d` 的序号把乱序的产出拼回正确顺序。管道是单条流，给不了这个保证 —— 所以「流式 + 多片」现在会直接抛错，而不是悄悄出错。

**代价**：落盘模式在合成失败时还能保留帧、重来；管道模式中途崩了就全得重渲。

**实测速度**：单片 19.7 fps（全长 14398 帧 ≈ 13.2 分钟）。流式改造**不改变这个数** —— 省掉的写盘只有 0.5ms/帧（见 §四）。

**已有的观察/调优开关**（都默认关闭，生产路径零影响）：
- `FOLIA_PROFILE=1` —— 打印逐帧各阶段耗时汇总
- `FOLIA_JPEG_QUALITY` —— 覆盖 JPEG 质量（默认 95；降它能省约 17ms/帧，代价是画质）

---

## 四、【实测】每帧耗时构成

**测量条件**：`local-test/陈小春 - 街角的晚风.mp3`，`--start 60 --duration 3`（178 帧），1920×1080 @60fps，quality 95。

### 总体

```
wall=68.9ms | setLine=0.6  frame=2.1  capture=66.2  decode=0.1  write=0.5
            | 分项和=69.5   未归属=-0.5
```

| 项 | 每帧均值 | 占比 |
|---|---|---|
| **`captureScreenshot`** | **65.7ms** | **95%** |
| `evaluate`（每帧一次） | 2.1ms | 3% |
| `setLine`（仅换行时） | 0.6ms | 1% |
| `writeFileSync` | 0.5ms | 1% |
| base64 解码 | 0.1ms | 0.1% |
| **未归属（隐性等待）** | **≈ 0** | **0%** |

**未归属是负的（-0.5ms），说明没有隐藏的等待** —— 时间全部落在我们自己发出的调用上。

### 把那 65.7ms 拆开

| 实验 | capture | 得出 |
|---|---|---|
| 基线（headless=new, q95） | 65.7ms | — |
| `FOLIA_JPEG_QUALITY=30` | 48.4ms | **JPEG 编码 ≈ 17ms** |
| 非 headless（窗口藏屏幕外） | 56.5ms | headless 只占 ~9ms |
| 加合成器/垂直同步开关 | 67.8ms | 无改善 |
| 960×540（1/4 像素量） | 43.0ms | **非线下降**（纯线性该到 16ms）→ 有固定成本 |
| `--disable-gpu` | 47.5ms | **快 18ms，但画面废掉**（见下） |

**⇒ 65.7ms ≈ JPEG 编码 17ms + 渲染/合成 48ms。**

### `--disable-gpu` 是个陷阱

它把 capture 从 65.7 降到 47.5（-18ms），看着很香。但同参数下渲染出的画面：

- 基线：灰色漩涡背景（`latent` 的 WebGL 着色器）
- `--disable-gpu`：**背景全黑**，着色器完全不工作

两帧的 PSNR 只有 **10.5dB**（40dB 以上才算肉眼看不出差别）。**歌词文字一样**（那是 DOM/CSS），但**背景整层没了**。

**原因**：`latent` 背景本身就是 WebGL 着色器，禁用 GPU 等于关掉它。
**结论**：这条优化**不可用** —— 违背「和 Folia 一致」这个前提。

---

## 五、被证伪的优化建议（初版推测 vs 实测）

初版文档从 Folia 的注释**推测**了几条改进方向。实测结果：

| 初版建议 | 理由（当时） | 实测 | 结论 |
|---|---|---|---|
| §四-1 内存管道 / 去中间文件 | Folia「raw pixel pipe，跳过 PNG 编解码」 | 写盘 **0.5ms**、base64 解码 0.1ms | ❌ **对速度零收益**（但见下方补充） |
| §四-2 流水线（重叠写盘与渲染） | Folia 注释说这是提速点 | 可重叠的只有 0.5ms | ❌ **零收益** |
| §四-3 减少每帧等待 | Folia「一个 rAF 就够」 | `setLine` 仅 0.6ms | ❌ 收益微乎其微 |
| §四-4 反 headless 节流 | Folia 特意用 shown 窗口回避 | 非 headless 只省 9ms | ⚠️ 有限，不值得换架构 |
| §四-5 ffmpeg 进程生命周期 | Folia 长期驻留一个进程 | 不在逐帧路径上（属合成阶段） | ❌ 与逐帧速度无关 |

**为什么错**：我把 Folia 的优化**当成通用结论**套用了。实际上它那些手段针对的是**Electron 主进程**的瓶颈（PNG 编解码挤占主进程、UI jank）—— **而我们的架构不同**：CDP 的截图编码发生在 Chrome 渲染进程里，写盘是 Bun 的，两者都不在关键路径上。

**教训**：上游的优化建议要先对照**架构差异**，再决定是否适用。

**补充（2026-10-19）：§四-1 最终做了，但理由换了。**

流式管道已经落地（见 §三）—— **不是为了速度，是为了磁盘占用**。一整首歌会生成 14398 个中间 jpg（约 4~6 GB），而且渲染中断后会留下来需要手动清。改成 `image2pipe` 直连后，中间帧为 0。

**速度基本没变**（符合上表的测量：写盘只占 0.5ms/帧），但磁盘占用从 GB 级降到零。这说明同一项改动可以有**完全不同的价值来源** —— 当初按「提速」评估它是错的，按「省磁盘」评估它是对的。

---

## 六、学不了的（CDP 的硬限制）

Folia 能做零编码，是因为 `webContents.capturePage()` 返回 `NativeImage`，可以 `.getBitmap()` 直接拿原始像素。

**CDP 没有等价能力**：`Page.captureScreenshot` 的 `format` 只支持 `png` / `jpeg` / `webp`，**拿不到原始像素**。这是协议层面的限制。

**但实测表明这不重要** —— 编码只占 17ms，去掉它也只能省 26%。真正的 48ms 在渲染。

---

## 七、并行为什么被搁置（保留结论备查）

`docs/TODO.md` 第 2 条记录了「切帧并行快 2.8 倍但画面会坏」。根因的机制解释：

1. **时间冻结不完整** —— `DRIVER_SRC` 接管了 JS 时钟，但**管不到 CSS `transition`（94 处）、CSS `animation`（15 条 + 11 个 `@keyframes`）、Web Animations（7 处 `.animate(`）** —— 这些由浏览器内核驱动，走真实时钟。
2. **headless 合成器只在截图时推进** —— 于是 **CSS 动画的推进量 ≈ 截图次数**。单片有 14000 次推进机会（早已稳态），分片只有 180 帧预热（停在过渡态）。
3. **状态是历史的函数** —— `stitch.ts` 里那段「退出行滞留 → rows > 2 就整树重置」就是证据；重置又会丢掉所有行的动画状态，于是出现 `maxOp=0`（整句不可见）。

**「切段」（`--start/--duration`）也有边界缺陷** —— 实测两段接缝处（60–63s / 63–66s）：**歌词整句消失**（跨界行的时间平移后为负被漏掉）且**背景纹理不连续**。

---

## 八、结论与建议

**实测确立的天花板**：这台机器上，1080p 的 Folia 视觉每帧需要 ~48ms 来渲染合成 —— 换算约 **20 fps**。我们测到的 19.7 fps 就是这个数。**它不是代码效率问题，是渲染负载。**

**由此推出三条**：

1. **没有免费的优化。** I/O（0.5ms）、编码（17ms）、协议（2ms）加起来不到 30%，而且省任何一项都不改变量级。唯一能省 18ms 的 `--disable-gpu` 直接毁掉背景。
2. **想提速只有并行。** 而且必须是**同等画质下的并行** —— 靠降画质换速度是可选项但不是「提速」。
3. **保真前提下的并行路线只有「切段」。** 每段从 0 开始渲染，状态自然正确；代价是段边界的视觉跳变（背景着色器相位不连续 + 跨界歌词行需处理）。

**可选的下一步**（按确定性排序）：

- **修「切段」的两个边界缺陷**：截音频时前置多带几秒（让跨界歌词行不被切掉）；段边界的背景跳变先量化再决定接不接受。
- **若要提速又不想动画质**，`FOLIA_JPEG_QUALITY` 是个可用的旋钮（17ms / 26% 的空间），但会牺牲画质，需要你判断值不值。
- **不要**再投入「优化单帧路径」—— 已测量到没有空间了。

---

## 九、仍然没有验证的事

- **Folia 路径 B 的实测速度** —— 只知道它有这条路，没跑过。它的 48ms 渲染成本大概率相同（同样的视觉），但没有数据。
- **`Page.startScreencast`** —— 没试过。它省的是 CDP 往返（实测只占 2ms），预计无意义。
- **段边界跳变到底有多大** —— 只确认了「歌词整句消失」（这是 bug，可修）和「背景纹理不同」，没有量化成可接受/不可接受的判断。
- **其他 13 种视觉模式** —— §四/§七 的所有测量都只在 `classic` + `latent` 上做过。
- **不同机器** —— 全部在一台 M 系列 Mac 上测的，GPU 路径的结论未必通用。

---

## 附：关键文件索引

**Folia（上游参照）**
- `electron/modSystem/exportService.cjs` —— 路径 B 的帧循环 + ffmpeg 管道（521 行）
- `src/mods/export/modExportPage.tsx` —— 合成时钟 `renderFrame` / 静态音频
- `src/services/electronVideoExport.ts` —— 路径 A：录屏 + canvas 纯裁切
- `electron/modSystem/ffmpeg.cjs` —— ffmpeg 二进制定位（注释解释了为什么导出需要「完整版」ffmpeg）

**本项目**
- `src/stitch.ts` —— 逐帧驱动 + 分片调度；流式模式下通过 `onFrameData` 回调交帧，`framesDir` 与它二选一（含 `FOLIA_PROFILE=1` 计时探针）
- `src/cdp.ts` —— 极简 CDP 客户端
- `src/render.ts` —— 频谱计算、封面、ffmpeg 合成；**单片走 `image2pipe` 流式管道，多片走落盘**（含 `FOLIA_JPEG_QUALITY` 旋钮）
- `tools/stream-pipe-test.ts` —— 守住「渲染全程不产生 `.frames-*`」这个行为（10 秒片段，约 17 秒跑完）
- `docs/TODO.md` 第 2 条 —— 并行渲染的既有实验记录
