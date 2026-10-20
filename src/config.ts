// 用户偏好持久化。放在家目录下的一个 JSON 里 —— 可执行文件可能被拷来拷去，
// 配置跟着用户走比跟着程序走更符合直觉。
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { LyricSourceId } from './lyrics/fetch.ts';

export type FfmpegChoice = 'auto' | 'system' | 'embedded';

/** 「歌词」那一行能记住的取值：联网（自动 / 某个源）或本地兜底。 */
export type LyricChoiceValue = 'auto' | LyricSourceId | 'local';

export interface Config {
  /** 用哪一份 ffmpeg。写在这里之后启动就不再问了。 */
  ffmpeg?: FfmpegChoice;
  /**
   * 「歌词」那一行选中的来源。不写就是 `local` —— 用与音频同名的 .lrc 兜底。
   *
   * 老版本这里是 `lyricSource`，含义是「联网时优先哪个源」，而默认仍然是本地配对。
   * 两者语义不同（老键不等于「一启动就联网」），所以**故意不迁移**：把老值直接当新值用，
   * 会让「本地兜底」静默变成「只用某一个源联网」。
   */
  lyricChoice?: LyricChoiceValue;
  /** 同时渲染几首（2..6）。不写就是 3。 */
  jobs?: number;
}

export const CONFIG_PATH = join(homedir(), '.config', 'folia-video', 'config.json');

/** 读配置。文件不存在或坏了都当空配置 —— 配置读不出来不该拦住程序启动。 */
export function loadConfig(): Config {
  try {
    const parsed: unknown = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
    return parsed && typeof parsed === 'object' ? (parsed as Config) : {};
  } catch {
    return {};
  }
}

/** 合并写入。写失败只警告不抛 —— 最多是下次再问一遍。 */
export function saveConfig(patch: Partial<Config>): void {
  try {
    const next = { ...loadConfig(), ...patch };
    mkdirSync(dirname(CONFIG_PATH), { recursive: true });
    writeFileSync(CONFIG_PATH, `${JSON.stringify(next, null, 2)}\n`);
  } catch (error) {
    console.error(`偏好保存失败（${(error as Error).message}），下次启动会再问一次。`);
  }
}
