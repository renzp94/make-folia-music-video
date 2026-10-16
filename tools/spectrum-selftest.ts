// 自检：固定 440Hz 正弦，频谱峰值必须落在 440Hz 附近的 bin
import { computeSpectrumFrames, frameToAudioBytes, FFT_SIZE } from '../src/spectrum.ts';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

// 用 ffmpeg 把测试音转成裸 PCM（f32le）
const raw = execFileSync('ffmpeg', [
  '-v', 'error', '-i', '/tmp/test-tone.wav',
  '-f', 'f32le', '-ac', '1', '-ar', '44100', '-',
], { maxBuffer: 1 << 28 });
const samples = new Float32Array(raw.buffer, raw.byteOffset, raw.byteLength / 4);
console.log(`PCM 样本数 ${samples.length}（${(samples.length / 44100).toFixed(2)}s）`);

const frames = computeSpectrumFrames(samples, 44100, 60, 0.6);
console.log(`帧数 ${frames.length}（60fps）`);

// 取中间一帧找峰值 bin
const mid = frames[Math.floor(frames.length / 2)];
let peak = 0;
for (let i = 1; i < mid.length; i++) if (mid[i] > mid[peak]) peak = i;
const peakHz = peak * (44100 / FFT_SIZE);
console.log(`峰值 bin=${peak} → ${peakHz.toFixed(1)}Hz  （期望 ≈440Hz）`);

const a = frameToAudioBytes(mid);
console.log(`audioPower=${a.audioPower.toFixed(1)} bass=${a.bass.toFixed(1)} mid=${a.mid.toFixed(1)} treble=${a.treble.toFixed(1)}`);

const ok = Math.abs(peakHz - 440) < 30;
console.log();
console.log(ok ? '✓ 峰值落在 440Hz，FFT 正确' : `✗ 峰值在 ${peakHz.toFixed(0)}Hz，不对`);

// 稳定性：同一输入跑两次必须完全一致
const again = computeSpectrumFrames(samples, 44100, 60, 0.6);
const same = frames.length === again.length && frames.every((f, i) =>
  f.length === again[i].length && f.every((v, j) => v === again[i][j]));
console.log(same ? '✓ 两次计算逐字节一致（确定性）' : '✗ 两次结果不同');
