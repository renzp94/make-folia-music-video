/**
 * 以最多 `limit` 个并发跑 `fn`。单个任务失败不会中断其他任务 ——
 * 返回值的顺序与 `items` 一致，由调用方决定怎么汇总。
 */
export async function runPool<T>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<void>,
): Promise<PromiseSettledResult<void>[]> {
  const results: PromiseSettledResult<void>[] = new Array(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const i = next++;
      if (i >= items.length) {
        return;
      }
      try {
        await fn(items[i], i);
        results[i] = { status: 'fulfilled', value: undefined };
      } catch (reason) {
        results[i] = { status: 'rejected', reason };
      }
    }
  };
  const count = Math.min(Math.max(1, limit), items.length);
  await Promise.all(Array.from({ length: count }, worker));
  return results;
}
