import { setTimeout as sleep } from "node:timers/promises";

const API = "https://discord.com/api/v10";
const MAX_RESPONSE_BYTES = 50_000;
const MIN_INTERVAL_MS = 1_000;
const REQUEST_TIMEOUT_MS = 60_000;
const MAX_RETRIES = 2;

export type Method = "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
export interface Request {
  method: Method;
  path: string;
  body?: Record<string, unknown>;
}
export interface ResponseData {
  status: number;
  statusText: string;
  text: string;
  truncated: boolean;
}
interface Runtime {
  fetch: typeof fetch;
  now: () => number;
  sleep: (ms: number, signal: AbortSignal) => Promise<void>;
}

export function requestUrl(path: string): string {
  if (!path.startsWith("/") || path.startsWith("//") || /[\\#\s\u0000-\u001f\u007f]/.test(path)) {
    throw new Error("Discord path must be an API-relative path starting with one '/'; no URLs, fragments, or whitespace.");
  }
  let decoded: string;
  try {
    decoded = decodeURIComponent(path.split("?")[0]);
  } catch {
    throw new Error("Discord path contains invalid percent encoding.");
  }
  if (decoded.split("/").some((part) => part === "." || part === "..") || /[\\\u0000-\u001f\u007f]/.test(decoded)) {
    throw new Error("Discord path cannot contain traversal or control characters.");
  }
  const url = new URL(API + path);
  if (url.origin !== "https://discord.com" || !url.pathname.startsWith("/api/v10/")) {
    throw new Error("Discord request must stay inside the Discord v10 API.");
  }
  return url.href;
}

export function redact(text: string, token: string): string {
  return token ? text.split(token).join("[redacted]") : text;
}

function seconds(value: unknown): number | undefined {
  if (typeof value !== "number" && typeof value !== "string") return undefined;
  if (typeof value === "string" && !value.trim()) return undefined;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number * 1_000 : undefined;
}

async function boundedText(response: Response): Promise<{ text: string; truncated: boolean }> {
  if (!response.body) return { text: "", truncated: false };
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) return { text: text + decoder.decode(), truncated: false };
      const remaining = MAX_RESPONSE_BYTES - bytes;
      text += decoder.decode(value.subarray(0, remaining), { stream: true });
      bytes += value.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        return { text: text + decoder.decode() + "\n…[truncated at 50,000 bytes; request a smaller page]", truncated: true };
      }
    }
  } finally {
    reader.releaseLock();
  }
}

function waitFor<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

/** Conservative account-wide scheduling; no gateway, polling, or background timers. */
export class DiscordClient {
  private tail: Promise<unknown> = Promise.resolve();
  private nextRequestAt = 0;
  private unauthorized = false;
  private authorization: string;
  private token: string;
  private runtime: Runtime;

  constructor(authorization: string, token: string, runtime: Partial<Runtime> = {}) {
    this.authorization = authorization;
    this.token = token;
    this.runtime = {
      fetch: (...args) => fetch(...args),
      now: Date.now,
      sleep: async (ms, signal) => { await sleep(ms, undefined, { signal }); },
      ...runtime,
    };
  }

  async request(request: Request, callerSignal?: AbortSignal): Promise<ResponseData> {
    const url = requestUrl(request.path);
    const signal = AbortSignal.any([AbortSignal.timeout(REQUEST_TIMEOUT_MS), ...(callerSignal ? [callerSignal] : [])]);
    const run = this.tail.then(() => this.perform(request, url, signal));
    // A cancelled caller must not release the queue while an earlier request is still active.
    this.tail = run.catch(() => undefined);
    try {
      return await waitFor(run, signal);
    } catch (error) {
      if (signal.aborted) {
        throw new Error(signal.reason?.name === "TimeoutError" ? "Discord request timed out (60s including queue/retries)." : "Discord request cancelled.");
      }
      throw new Error(redact(error instanceof Error ? error.message : "Discord request failed.", this.token));
    }
  }

  private async perform(request: Request, url: string, signal: AbortSignal): Promise<ResponseData> {
    signal.throwIfAborted();
    if (this.unauthorized) throw new Error("Discord token was rejected (401); replace it or reload after correcting credentials.");
    for (let attempt = 0; ; attempt++) {
      const delay = Math.max(0, this.nextRequestAt - this.runtime.now());
      if (delay > REQUEST_TIMEOUT_MS) throw new Error("Discord cooldown exceeds this call's 60-second deadline; try again after the server cooldown.");
      if (delay) await this.runtime.sleep(delay, signal);
      signal.throwIfAborted();
      this.nextRequestAt = this.runtime.now() + MIN_INTERVAL_MS;
      const response = await this.runtime.fetch(url, {
        method: request.method,
        headers: { Authorization: this.authorization, "Content-Type": "application/json" },
        body: request.body ? JSON.stringify(request.body) : undefined,
        redirect: "error",
        signal,
      });
      const exhausted = response.headers.get("x-ratelimit-remaining") === "0";
      const reset = seconds(response.headers.get("x-ratelimit-reset-after"));
      if (exhausted && reset !== undefined) this.nextRequestAt = Math.max(this.nextRequestAt, this.runtime.now() + reset);
      if (response.status === 401) this.unauthorized = true;
      const result = await boundedText(response);
      if (response.status === 429) {
        let retry: unknown;
        try { retry = JSON.parse(result.text).retry_after; } catch { /* Header remains usable. */ }
        const waits = [seconds(response.headers.get("retry-after")), seconds(retry)].filter((ms): ms is number => ms !== undefined);
        if (waits.length) this.nextRequestAt = Math.max(this.nextRequestAt, this.runtime.now() + Math.max(...waits));
        if (waits.length && attempt < MAX_RETRIES) continue;
      } else if (response.status >= 500 && request.method === "GET" && attempt < MAX_RETRIES) {
        this.nextRequestAt = Math.max(this.nextRequestAt, this.runtime.now() + 1_000 * 2 ** attempt);
        continue;
      }
      if (!response.ok) throw new Error(`Discord HTTP ${response.status}: ${redact(result.text || response.statusText, this.token)}`);
      return { status: response.status, statusText: response.statusText, text: redact(result.text, this.token), truncated: result.truncated };
    }
  }
}
