// 离线频谱：读 PCM → 按帧算 FFT → 复刻 WebAudio getByteFrequencyData 的语义
//
// 为什么不用 AnalyserNode：它只在实时上下文里工作；suspend 取值的做法实测值会累积漂移
// （固定正弦本该稳定，实测 59→133→177），结果依赖调用时机。所以自己算。
//
// 要复刻的是上游 Folia 拿到的那套语义（WebAudio getByteFrequencyData）：
//   byte = 255 * (dB - minDecibels) / (maxDecibels - minDecibels)   [默认 -100 .. -30]
// 外面再套 EchoMusic/Folia 那套 smoothing（EMA）与 process 幂压缩。

export const FFT_SIZE = 2048;
export const MIN_DB = -100;
export const MAX_DB = -30;

/** 一帧频谱字节 → Folia 需要的 audioPower / audioBands 值。 */
export type AudioBytes = {
  audioPower: number; bass: number; lowMid: number; mid: number;
  vocal: number; treble: number; spectrum: Uint8Array;
};

/** 原位 radix-2 FFT（实部/虚部数组长度必须是 2 的幂）。 */
function fft(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const ur = re[i + k], ui = im[i + k];
        const vr = re[i + k + len / 2] * cr - im[i + k + len / 2] * ci;
        const vi = re[i + k + len / 2] * ci + im[i + k + len / 2] * cr;
        re[i + k] = ur + vr; im[i + k] = ui + vi;
        re[i + k + len / 2] = ur - vr; im[i + k + len / 2] = ui - vi;
        const ncr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr; cr = ncr;
      }
    }
  }
}

/** 单帧窗口 → 0..255 的频谱字节（长度 fftSize/2）。 */
export function frameToBytes(samples: Float32Array, start: number, fftSize = FFT_SIZE): Uint8Array {
  const n = fftSize;
  const re = new Float64Array(n);
  const im = new Float64Array(n);
  // Hann 窗，与 WebAudio 一致地压旁瓣
  for (let i = 0; i < n; i++) {
    const s = samples[start + i] ?? 0;
    re[i] = s * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1)));
  }
  fft(re, im);
  const half = n / 2;
  const out = new Uint8Array(half);
  const norm = 1 / (n / 4); // 幅度归一（窗增益补偿）
  for (let k = 0; k < half; k++) {
    const mag = Math.hypot(re[k], im[k]) * norm;
    const db = 20 * Math.log10(Math.max(mag, 1e-10));
    const t = (db - MIN_DB) / (MAX_DB - MIN_DB);
    out[k] = Math.max(0, Math.min(255, Math.round(t * 255)));
  }
  return out;
}

/**
 * 对整段 PCM 按 fps 逐帧出频谱（含 WebAudio 的 smoothingTimeConstant 语义）。
 * @returns Uint8Array[] 每帧一个长度 fftSize/2 的数组
 */
export function computeSpectrumFrames(samples: Float32Array, sampleRate: number, fps: number, smoothing = 0.6, fftSize = FFT_SIZE): Uint8Array[] {
  const frames: Uint8Array[] = [];
  const hop = sampleRate / fps;
  const total = Math.floor((samples.length - fftSize) / hop) + 1;
  let prev: Uint8Array | null = null;
  for (let f = 0; f < total; f++) {
    const start = Math.round(f * hop);
    const raw = frameToBytes(samples, start, fftSize);
    const smoothed = new Uint8Array(raw.length);
    if (!prev) {
      smoothed.set(raw);
    } else {
      for (let i = 0; i < raw.length; i++) {
        smoothed[i] = Math.round(smoothing * prev[i] + (1 - smoothing) * raw[i]);
      }
    }
    prev = smoothed;
    frames.push(smoothed);
  }
  return frames;
}

/** 线性频率刻度下 [fromHz,toHz] 的均值（上游 getEnergy 的语义，21.5Hz/bin @44100）。 */
export function bandEnergy(bytes: Uint8Array, fromHz: number, toHz: number, hzPerBin = 44100 / 2048): number {
  const from = Math.max(0, Math.floor(fromHz / hzPerBin));
  const to = Math.min(bytes.length - 1, Math.max(from, Math.floor(toHz / hzPerBin)));
  let sum = 0;
  for (let i = from; i <= to; i++) sum += bytes[i];
  return sum / (to - from + 1);
}

export const processBoost = (value: number, boost = 2): number => Math.pow(value / 255, boost) * 255;

export const BANDS_HZ: Record<string, [number, number]> = {
  bass: [20, 150], lowMid: [150, 400], mid: [400, 1200],
  vocal: [1000, 3500], treble: [3500, 12000],
};
export const BOOSTS: Record<string, number> = { bass: 1.8, lowMid: 2, mid: 2, vocal: 1.5, treble: 2, power: 3 };

/** 一帧的频谱字节 → Folia 需要的 audioPower / audioBands 值。 */
export function frameToAudioBytes(bytes: Uint8Array): AudioBytes {
  const e: Record<string, number> = {};
  for (const [k, [a, b]] of Object.entries(BANDS_HZ)) e[k] = bandEnergy(bytes, a, b);
  return {
    audioPower: processBoost((e.bass + e.lowMid) / 2, BOOSTS.power),
    bass: processBoost(e.bass, BOOSTS.bass),
    lowMid: processBoost(e.lowMid, BOOSTS.lowMid),
    mid: processBoost(e.mid, BOOSTS.mid),
    vocal: processBoost(e.vocal, BOOSTS.vocal),
    treble: processBoost(e.treble, BOOSTS.treble),
    spectrum: bytes,
  };
}
