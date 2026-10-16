// 并行加速比实测
import { renderFramesParallel } from '../src/stitch.ts';
import { computeSpectrumFrames, frameToAudioBytes, BANDS_HZ } from '../src/spectrum.ts';
import { findLineIndex } from '../src/render.ts';
import { spawn, type SpawnOptions } from 'node:child_process';
import { rmSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, readFileSync } from 'node:fs';

const here = dirname(fileURLToPath(import.meta.url));
const siteDir = join(here, '..', 'site');

// PCM
// stdout 是 Node spawn 的简写选项，运行时支持，但 @types/node 的 SpawnOptions 未声明，故断言
const r = spawn('ffmpeg', ['-v','error','-i','/tmp/test-20s.wav','-f','f32le','-ac','1','-ar','44100','-'], { stdout: 'pipe' } as SpawnOptions);
const chunks: Buffer[] = []; r.stdout!.on('data', c => chunks.push(c));
await new Promise(res => r.on('close', res));
const buf = Buffer.concat(chunks);
const samples = new Float32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));

const FPS = 30;
const spec = computeSpectrumFrames(samples, 44100, FPS, 0.6).map(frameToAudioBytes);
const lines = [
  { text: '雨淋湿了天空', startTime: 0.5, endTime: 2.5, fullText: '雨淋湿了天空', words: [{ text:'雨淋湿了',startTime:0.5,endTime:1.5 },{ text:'天空',startTime:1.5,endTime:2.5 }] },
  { text: '灰得像哭过', startTime: 2.8, endTime: 4.8, fullText: '灰得像哭过', words: [{ text:'灰得像',startTime:2.8,endTime:3.8 },{ text:'哭过',startTime:3.8,endTime:4.8 }] },
];
const specFrames = spec.map((b, i) => ({ power: b.audioPower, bass: b.bass, lowMid: b.lowMid, mid: b.mid,
  vocal: b.vocal, treble: b.treble, lineIndex: findLineIndex(lines, i / FPS) }));

// 静态服务
const srv = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch(req) {
  const p = join(siteDir, new URL(req.url).pathname);
  if (!existsSync(p)) return new Response('404', { status: 404 });
  return new Response(Bun.file(p));
}});
const siteUrl = `http://127.0.0.1:${srv.port}`;

const W = 1280, H = 720;
for (const workers of [1, 4]) {
  const dir = `/tmp/pb-${workers}`;
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const t0 = Date.now();
  await renderFramesParallel({
    siteUrl, framesDir: dir, totalFrames: specFrames.length, fps: FPS,
    foliaLines: lines, specFrames, width: W, height: H, workers, fmt: 'jpeg',
  });
  const ms = Date.now() - t0;
  console.log(`  ${workers} 路并行: ${(specFrames.length / (ms / 1000)).toFixed(1)} fps  （${ms}ms / ${specFrames.length} 帧）`);
  rmSync(dir, { recursive: true, force: true });
}
srv.stop(true);
