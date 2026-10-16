// 移植自 folia-major src/utils/lyrics/duration.ts @ 7db1ad56
// 改动：无。
// src/utils/lyrics/duration.ts

const MAX_REASONABLE_SONG_DURATION_MS = 12 * 60 * 60 * 1000;

// Normalizes song durations to milliseconds and defensively fixes accidental ms * 1000 inputs.
export const normalizeLyricMatchDurationMs = (duration: number | null | undefined): number => {
    if (!Number.isFinite(duration) || !duration || duration <= 0) {
        return 0;
    }

    if (duration > MAX_REASONABLE_SONG_DURATION_MS) {
        return duration / 1000;
    }

    return duration;
};
