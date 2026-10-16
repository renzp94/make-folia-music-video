// 移植自 folia-major src/utils/lyrics/providers/krcDecrypt.ts @ 7db1ad56
// 改动：1) 新增 import 'node:zlib'（上游无 import，XOR 解密部分逐字节原样未动）；
//      2) 【Bun 平台差异，非上游原貌】decompressDeflate 的内部实现由 DecompressionStream('deflate')
//         换成 node:zlib 的 inflateSync —— 原因与证据见该函数内注释。
//         这是 brief 未预料的偏差（与 Task 4 的 qrcDecrypt.ts 同类），若需回退：还原该函数 + 删掉那行 import。
// src/utils/lyrics/providers/krcDecrypt.ts

/**
 * Kugou KRC lyric decryption and decompression module.
 * Decrypts encrypted KRC buffer into plain text LRC-like string.
 */

import { inflateSync } from 'node:zlib';

const KRC_KEY = new Uint8Array([
  64, 71, 97, 119, 94, 50, 116, 71, 81, 54, 49, 45, 206, 210, 110, 105
]);

/**
 * Helper to decompress zlib-compressed data using node:zlib.
 */
async function decompressDeflate(bytes: Uint8Array): Promise<string> {
  // 【Bun 平台差异，偏离上游】上游此处用 DecompressionStream('deflate')。Chromium 会先把解压出的
  // chunk 吐出来，随后才因 zlib 流尾的填充字节抛 ERR_TRAILING_JUNK_AFTER_STREAM_END，故上游那个
  // 「chunks 为空就 throw」的容错分支吞得掉；Bun 则是在吐出任何 chunk 之前就抛同一个错（chunks 恒为空，
  // 异常被原样抛出，KRC 一条都解不出来）。换成 node:zlib.inflateSync：同样把 zlib 流解成文本，
  // 且与 Chromium 一样忽略流尾垃圾。与 Task 4 的 qrcDecrypt.ts 处理同类问题的方式保持一致。
  return new TextDecoder('utf-8').decode(inflateSync(bytes));
}

/**
 * Decrypts Kugou KRC format bytes.
 * Skip first 4 bytes ("krc1"), XOR with the static key, and inflate.
 */
export async function krcDecrypt(encryptedBytes: Uint8Array): Promise<string> {
  if (encryptedBytes.length <= 4) {
    throw new Error('Invalid KRC data: too short');
  }

  // Skip the first 4 bytes (header "krc1")
  const data = encryptedBytes.subarray(4);
  const decrypted = new Uint8Array(data.length);

  for (let i = 0; i < data.length; i++) {
    decrypted[i] = data[i] ^ KRC_KEY[i % KRC_KEY.length];
  }

  return await decompressDeflate(decrypted);
}
