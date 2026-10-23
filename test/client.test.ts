import assert from "node:assert/strict";
import { test } from "node:test";
import { DiscordClient, requestUrl } from "../src/client.ts";

function fixture(responses: Array<Response | Error>) {
  let now = 0;
  const calls: Array<{ url: string; options: RequestInit | undefined; time: number }> = [];
  const waits: number[] = [];
  const client = new DiscordClient("Bot fake-token", "fake-token", {
    now: () => now,
    sleep: async (ms, signal) => { signal.throwIfAborted(); waits.push(ms); now += ms; },
    fetch: async (url, options) => {
      calls.push({ url: String(url), options, time: now });
      const response = responses.shift();
      if (response instanceof Error) throw response;
      assert.ok(response, "unexpected extra HTTP request");
      return response;
    },
  });
  return { client, calls, waits };
}
const get = { method: "GET" as const, path: "/users/@me" };
const ok = () => new Response('{"ok":true}', { status: 200 });

test("rejects arbitrary URL, traversal, encoded traversal, fragments and backslashes", () => {
  assert.equal(requestUrl("/channels/123/messages?limit=25&before=456"), "https://discord.com/api/v10/channels/123/messages?limit=25&before=456");
  for (const path of ["https://evil.test", "//evil.test", "/../users", "/%2e%2e/users", "/foo%2f..%2f../users", "/foo\\bar", "/foo%5cbar", "/foo#bar", "/foo\nbar", "/foo%00bar", "/%zz"]) assert.throws(() => requestUrl(path), /Discord/);
});
test("sends correct JSON auth and refuses redirects", async () => {
  const { client, calls } = fixture([ok()]);
  const result = await client.request({ method: "POST", path: "/channels/123/messages", body: { content: "hi" } });
  assert.equal(result.status, 200);
  assert.equal(calls[0].options?.redirect, "error");
  assert.equal((calls[0].options?.headers as Record<string, string>).Authorization, "Bot fake-token");
  assert.equal(calls[0].options?.body, '{"content":"hi"}');
});
test("serializes concurrent requests with minimum pacing", async () => {
  const { client, calls } = fixture([ok(), ok(), ok()]);
  await Promise.all([client.request(get), client.request(get), client.request(get)]);
  assert.deepEqual(calls.map((call) => call.time), [0, 1_000, 2_000]);
});
test("honors exhausted bucket cooldown across routes", async () => {
  const first = new Response("[]", { headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset-after": "2.5" } });
  const { client, calls } = fixture([first, ok()]);
  await client.request(get);
  await client.request({ ...get, path: "/channels/123/messages" });
  assert.deepEqual(calls.map((call) => call.time), [0, 2_500]);
});
test("429 uses longest header/body wait, including global cooldown, then retries", async () => {
  const limited = new Response('{"retry_after":2.5,"global":true}', { status: 429, headers: { "retry-after": "2" } });
  const { client, calls } = fixture([limited, ok(), ok()]);
  await client.request(get);
  await client.request({ ...get, path: "/channels/123/messages" });
  assert.deepEqual(calls.map((call) => call.time), [0, 2_500, 3_500]);
});
test("429 retries are bounded and missing timing does not invent a retry", async () => {
  const limited = () => new Response('{"retry_after":1}', { status: 429 });
  const { client, calls } = fixture([limited(), limited(), limited()]);
  await assert.rejects(client.request(get), /HTTP 429/);
  assert.equal(calls.length, 3);
  const missing = fixture([new Response("{}", { status: 429 })]);
  await assert.rejects(missing.client.request(get), /HTTP 429/);
  assert.equal(missing.calls.length, 1);
});
test("oversized server cooldown never overflows a timer or retries early", async () => {
  const { client, calls } = fixture([new Response('{"retry_after":3000000}', { status: 429 })]);
  await assert.rejects(client.request(get), /cooldown exceeds/);
  assert.equal(calls.length, 1);
  await assert.rejects(client.request(get), /cooldown exceeds/);
  assert.equal(calls.length, 1);
});
test("only GET retries server errors; writes and network errors are never replayed", async () => {
  const reads = fixture([new Response("oops", { status: 503 }), new Response("oops", { status: 503 }), ok()]);
  await reads.client.request(get);
  assert.equal(reads.calls.length, 3);
  const writes = fixture([new Response("oops", { status: 503 })]);
  await assert.rejects(writes.client.request({ ...get, method: "POST" }), /HTTP 503/);
  assert.equal(writes.calls.length, 1);
  const network = fixture([new Error("network failure fake-token")]);
  await assert.rejects(network.client.request({ ...get, method: "POST" }), (error: Error) => !error.message.includes("fake-token") && error.message.includes("network failure"));
  assert.equal(network.calls.length, 1);
});
test("HTTP errors fail and 401 disables subsequent traffic for that credential", async () => {
  const rejected = fixture([new Response("bad fake-token", { status: 401 })]);
  await assert.rejects(rejected.client.request(get), (error: Error) => /HTTP 401/.test(error.message) && !error.message.includes("fake-token"));
  await assert.rejects(rejected.client.request(get), /token was rejected/);
  assert.equal(rejected.calls.length, 1);
  for (const status of [403, 404]) {
    const error = fixture([new Response("denied", { status })]);
    await assert.rejects(error.client.request(get), new RegExp(`HTTP ${status}`));
    assert.equal(error.calls.length, 1);
  }
});
test("bounds streaming bytes, cancels oversized response, and handles empty responses", async () => {
  let cancelled = false;
  let chunks = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (chunks++ === 0) controller.enqueue(new TextEncoder().encode("é".repeat(30_000)));
      else controller.close();
    },
    cancel() { cancelled = true; },
  }, { highWaterMark: 0 });
  const { client } = fixture([new Response(stream), new Response(null, { status: 204 })]);
  const result = await client.request(get);
  assert.equal(result.truncated, true);
  assert.equal(cancelled, true);
  assert.match(result.text, /truncated/);
  assert.ok(result.text.length < 30_000);
  const empty = await client.request(get);
  assert.equal(empty.status, 204);
  assert.equal(empty.text, "");
});
test("redacts exact credential from successful responses", async () => {
  const { client } = fixture([new Response("echo fake-token")]);
  assert.equal((await client.request(get)).text, "echo [redacted]");
});
test("cancellation before execution never calls fetch", async () => {
  const { client, calls } = fixture([]);
  const abort = new AbortController();
  abort.abort();
  await assert.rejects(client.request(get, abort.signal), /cancelled/);
  assert.equal(calls.length, 0);
});
test("cancelled queued caller returns promptly without releasing the account lock", async () => {
  let release!: (response: Response) => void;
  let started!: () => void;
  const ready = new Promise<void>((resolve) => { started = resolve; });
  const first = new Promise<Response>((resolve) => { release = resolve; });
  let calls = 0;
  const client = new DiscordClient("Bot fake-token", "fake-token", {
    sleep: async () => {},
    fetch: async () => { calls++; if (calls === 1) { started(); return first; } return ok(); },
  });
  const running = client.request(get);
  await ready;
  const abort = new AbortController();
  const queued = client.request(get, abort.signal);
  const third = client.request(get);
  abort.abort();
  await assert.rejects(queued, /cancelled/);
  assert.equal(calls, 1);
  release(ok());
  await running;
  await third;
  assert.equal(calls, 2);
});
test("deadline covers queue and body reads", async () => {
  const original = AbortSignal.timeout;
  let requested = 0;
  AbortSignal.timeout = (ms) => { requested = ms; return original(10); };
  const hold = setTimeout(() => {}, 1_000);
  try {
    const client = new DiscordClient("Bot fake-token", "fake-token", {
      fetch: async (_url, options) => new Response(new ReadableStream({
        start(controller) { options?.signal?.addEventListener("abort", () => controller.error(options.signal?.reason), { once: true }); },
      })),
    });
    await assert.rejects(client.request(get), /timed out/);
    assert.equal(requested, 60_000);
  } finally { AbortSignal.timeout = original; clearTimeout(hold); }
});
