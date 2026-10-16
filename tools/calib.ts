// 看实际 byte 分布，据此标定 dB 区间
import { computeSpectrumFrames, bandEnergy, BANDS_HZ } from '../src/spectrum.ts';
import { execFileSync } from 'node:child_process';

const raw = execFileSync('ffmpeg', ['-v','error','-i','/tmp/test-tone.wav',
  '-f','f32le','-ac','1','-ar','44100','-'], { maxBuffer: 1<<28 });
const s = new Float32Array(raw.buffer, raw.byteOffset, raw.byteLength/4);
const frames = computeSpectrumFrames(s, 44100, 60, 0.6);
const mid = frames[Math.floor(frames.length/2)];

const sorted = [...mid].sort((a,b)=>a-b);
const q = (p: number) => sorted[Math.min(sorted.length-1, Math.floor(sorted.length*p))];
console.log('满幅 440Hz 正弦的 byte 分布：');
console.log(`  p50=${q(.5)}  p90=${q(.9)}  p99=${q(.99)}  max=${sorted[sorted.length-1]}`);
const nonzero = sorted.filter(v=>v>0);
console.log(`  非零 bin 数=${nonzero.length}/${sorted.length}`);
console.log(`  峰值 bin 附近: ${mid.slice(18,24).join(', ')}`);

console.log('\n各频段能量（当前标定下）：');
for (const [k,[a,b]] of Object.entries(BANDS_HZ)) {
  console.log(`  ${k.padEnd(8)} ${bandEnergy(mid,a,b).toFixed(1)}`);
}
console.log('\n→ 峰值 bin 只有 ' + sorted[sorted.length-1] +
  '，而满幅信号本该接近 255。当前 MIN_DB=-100/MAX_DB=-30 太宽，需要按实测收窄。');
