/**
 * `#ffmpeg-bin` 的实际文件由 package.json 的 `imports` 映射按平台选出，
 * tsc/bun check 看不到那层映射，所以在这里补一份声明。
 */
declare module '#ffmpeg-bin' {
  const path: string;
  export default path;
}
