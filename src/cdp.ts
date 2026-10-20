// 极简 CDP 客户端 —— 不依赖 Playwright，只用 Bun 内置的 fetch + WebSocket，
// 这样整个工具可以 `bun build --compile` 打成单文件。
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CHROME_CANDIDATES: string[] = [
  process.env.CHROME_PATH,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
].filter((p): p is string => Boolean(p));

/** 一个跑起来的 headless Chrome。 */
export interface Chrome {
  proc: ChildProcess;
  port: number;
  profileDir: string;
  url: string;
}

/** 连上某个 page 的 CDP 通道。 */
export interface CdpClient {
  send: (method: string, params?: Record<string, unknown>) => Promise<unknown>;
  close: () => void;
}

export function findChrome(): string | null {
  return CHROME_CANDIDATES.find((p) => existsSync(p)) ?? null;
}

/** 起一个 headless Chrome，返回 { proc, port, profileDir, url }。 */
export async function launchChrome({ width = 1920, height = 1080 }: { width?: number; height?: number } = {}): Promise<Chrome> {
  const chrome = findChrome();
  if (!chrome) throw new Error('找不到 Chrome / Chromium，可用 CHROME_PATH 指定');
  const profileDir = mkdtempSync(join(tmpdir(), 'folia-chrome-'));
  const proc = spawn(chrome, [
    '--headless=new',
    '--remote-debugging-port=0',
    '--remote-allow-origins=*',
    '--no-first-run', '--no-default-browser-check',
    '--disable-extensions', '--disable-background-networking',
    '--hide-scrollbars', '--mute-audio',
    `--window-size=${width},${height}`,
    `--user-data-dir=${profileDir}`,
    'about:blank',
  ], { stdio: ['ignore', 'pipe', 'pipe'] });

  // 端口从 stderr 的 "DevTools listening on ws://127.0.0.1:PORT/..." 里读
  const port = await new Promise<number>((resolve, reject) => {
    let buf = '';
    // 超时时带上 Chrome 自己的输出 —— 并发启动出问题时，光看「超时」没法定位
    const to = setTimeout(() => reject(new Error(
      `Chrome 启动超时${buf.trim() ? `：${buf.trim().slice(-300)}` : ''}`,
    )), 20000);
    // stdio 里已声明 stderr: 'pipe'，这里必然非空
    proc.stderr!.on('data', (c) => {
      buf += c.toString();
      const m = /DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)/.exec(buf);
      if (m) { clearTimeout(to); resolve(Number(m[1])); }
    });
    proc.on('exit', (code) => { clearTimeout(to); reject(new Error(`Chrome 退出，code=${code}`)); });
  });

  return { proc, port, profileDir, url: `http://127.0.0.1:${port}` };
}

export function killChrome(browser: Chrome): void {
  try { browser.proc.kill('SIGKILL'); } catch {}
  try { rmSync(browser.profileDir, { recursive: true, force: true }); } catch {}
}

/** CDP `/json/list` 里的一个 target（只用到这两个字段）。 */
interface CdpTarget { type?: string; webSocketDebuggerUrl?: string }

/** CDP 返回的一条消息（只用到这几个字段）。 */
interface CdpMessage { id?: number; error?: { message: string; code: number }; result?: unknown }

/** 连上某个 page 的 CDP，返回 { send, close }。 */
export async function connectCdp(browser: Chrome, { timeoutMs = 20000 }: { timeoutMs?: number } = {}): Promise<CdpClient> {
  const deadline = Date.now() + timeoutMs;
  let target: CdpTarget | undefined;
  while (Date.now() < deadline) {
    const list = (await (await fetch(`${browser.url}/json/list`)).json()) as CdpTarget[];
    target = list.find((t) => t.type === 'page');
    if (target?.webSocketDebuggerUrl) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  if (!target) throw new Error('拿不到 CDP page target');

  const ws = new WebSocket(target.webSocketDebuggerUrl!);
  let id = 0;
  const pending = new Map<number, { res: (v: unknown) => void; rej: (e: Error) => void }>();
  ws.onmessage = (e) => {
    const m = JSON.parse(typeof e.data === 'string' ? e.data : e.data.toString()) as CdpMessage;
    if (m.id && pending.has(m.id)) {
      const { res, rej } = pending.get(m.id)!;
      pending.delete(m.id);
      m.error ? rej(new Error(`${m.error.message} (${m.error.code})`)) : res(m.result);
    }
  };
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

  const send = (method: string, params: Record<string, unknown> = {}): Promise<unknown> => new Promise((res, rej) => {
    const n = ++id;
    pending.set(n, { res, rej });
    ws.send(JSON.stringify({ id: n, method, params }));
  });

  return { send, close: () => ws.close() };
}
