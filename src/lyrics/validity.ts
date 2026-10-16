// 移植自 folia-major src/utils/lyrics/validity.ts @ 7db1ad56
// 改动：只改了 import 路径（../../types → ./types）。
import type { LyricData } from './types';

// Shared content-level validation for parsed lyrics returned by every source.
export const hasRenderableLyrics = (lyricData: LyricData | null | undefined): lyricData is LyricData => {
    if (!lyricData?.lines?.length) {
        return false;
    }

    return lyricData.lines.some(line =>
        line.fullText.trim().length > 0 || (line.translation?.trim().length ?? 0) > 0
    );
};
