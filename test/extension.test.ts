import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import type { ExtensionAPI, ExtensionToolContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import extension from "../src/index.ts";

let originalFetch: typeof fetch;
let saved: Record<string, string | undefined>;
let home: string;
let requests: Array<{ url: string; options?: RequestInit }>;
beforeEach(() => {
  saved = { ...process.env };
  for (const key of Object.keys(process.env)) if (key.startsWith("DISCORD_")) delete process.env[key];
  home = mkdtempSync(join(tmpdir(), "pi-cord-extension-"));
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  process.env.DISCORD_BOT_TOKEN = "fake-bot-token";
  process.env.DISCORD_USER_TOKEN = "fake-user-token";
  requests = [];
  originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => { requests.push({ url: String(url), options }); return new Response("[]"); };
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
  Object.assign(process.env, saved);
  rmSync(home, { recursive: true, force: true });
});
function setup(hasUI = true, approve = true) {
  let tool!: ToolDefinition<any>;
  const hooks = new Map<string, () => Promise<void>>();
  const confirmations: string[] = [];
  const warnings: string[] = [];
  extension({ registerTool: (value: ToolDefinition<any>) => { tool = value; }, on: (event: string, handler: () => Promise<void>) => { hooks.set(event, handler); } } as unknown as ExtensionAPI);
  const context = { hasUI, ui: { confirm: async (_title: string, text: string) => { confirmations.push(text); return approve; }, notify: (text: string) => { warnings.push(text); } } } as unknown as ExtensionToolContext;
  const execute = (params: Record<string, unknown>, signal?: AbortSignal) => tool.execute("call", params, signal, undefined, context);
  return { tool, execute, confirmations, warnings, hooks, context };
}
const read = { method: "GET", path: "/channels/123/messages?limit=25" };
const write = { method: "POST", path: "/channels/123/messages", body: { content: "Hello @everyone" } };

test("retains one discord tool and headless reads need no approval", async () => {
  const { tool, execute, confirmations } = setup(false);
  assert.equal(tool.name, "discord");
  const result = await execute(read);
  assert.equal(requests.length, 1);
  assert.equal((requests[0].options?.headers as Record<string, string>).Authorization, "Bot fake-bot-token");
  assert.equal(confirmations.length, 0);
  assert.equal((result.details as { account: string }).account, "bot");
});
test("user read stays explicit and unprefixed, with a policy warning", async () => {
  const { execute, warnings } = setup();
  await execute({ ...read, account: "user" });
  assert.equal((requests[0].options?.headers as Record<string, string>).Authorization, "fake-user-token");
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /including reads/);
  assert.match(warnings[0], /terminate/);
});
test("writes require approval inside execute for both account types", async () => {
  for (const account of ["bot", "user"]) {
    const { execute, confirmations } = setup(true, false);
    await assert.rejects(execute({ ...write, account }), /declined/);
    assert.match(confirmations[0], /Hello @everyone/);
    assert.match(confirmations[0], /allowed_mentions/);
    assert.equal(requests.length, 0);
  }
});
test("no UI means no write, including direct/nested executor access", async () => {
  for (const account of ["bot", "user"]) {
    const { execute } = setup(false);
    await assert.rejects(execute({ ...write, account }), /no UI/);
  }
  assert.equal(requests.length, 0);
});
test("approval sends prepared body once, with mention protection and correct account", async () => {
  const { execute, confirmations } = setup();
  await execute({ ...write, account: "user" });
  assert.equal(requests.length, 1);
  assert.match(confirmations[0], /personal account/);
  const body = JSON.parse(String(requests[0].options?.body));
  assert.deepEqual(body.allowed_mentions, { parse: [], replied_user: false });
  assert.equal(body.content, "Hello @everyone");
  assert.equal((requests[0].options?.headers as Record<string, string>).Authorization, "fake-user-token");
});
test("webhook message writes suppress mentions, preserve explicit choices and leave metadata alone", async () => {
  for (const operation of [
    { method: "POST", path: "/webhooks/123/fake-webhook-token?wait=true" },
    { method: "PATCH", path: "/webhooks/123/fake-webhook-token/messages/@original" },
    { method: "PATCH", path: "/webhooks/123/fake-webhook-token/messages/456?thread_id=789" },
    { method: "POST", path: "/webhooks/123/fake-webhook-token", explicit: true },
    { method: "PATCH", path: "/webhooks/123/fake-webhook-token", metadata: true },
  ]) {
    const { execute, confirmations } = setup();
    const mentions = { parse: ["users"] };
    const body = operation.metadata ? { name: "renamed" } : { content: "Hello @everyone", ...(operation.explicit ? { allowed_mentions: mentions } : {}) };
    await execute({ method: operation.method, path: operation.path, body });
    const sent = JSON.parse(String(requests.at(-1)?.options?.body));
    if (operation.metadata) assert.deepEqual(sent, body);
    else {
      assert.deepEqual(sent.allowed_mentions, operation.explicit ? mentions : { parse: [], replied_user: false });
      assert.match(confirmations[0], /allowed_mentions/);
    }
    assert.equal("allowed_mentions" in body, !!operation.explicit);
  }
});
test("explicit mentions survive approval and full request cannot change during confirmation", async () => {
  const { execute, context } = setup();
  const params = { ...write, body: { content: "hi", allowed_mentions: { parse: ["users"] } } };
  context.ui.confirm = async () => { params.path = "/channels/999/messages"; params.body.content = "changed"; return true; };
  await execute(params);
  assert.match(requests[0].url, /channels\/123\/messages/);
  assert.deepEqual(JSON.parse(String(requests[0].options?.body)), { content: "hi", allowed_mentions: { parse: ["users"] } });
});
test("rejects GET bodies, oversized writes, invalid routes and account selectors before HTTP", async () => {
  const { execute, confirmations } = setup();
  await assert.rejects(execute({ ...read, body: {} }), /GET requests/);
  await assert.rejects(execute({ ...write, body: { content: "x".repeat(16_001) } }), /16,000 bytes/);
  await assert.rejects(execute({ ...read, path: "/../users/@me" }), /traversal/);
  await assert.rejects(execute({ ...read, account: "user", bot: "work" }), /cannot be combined/);
  await assert.rejects(execute({ ...read, account: "invalid" }), /must be bot or user/);
  assert.equal(requests.length, 0);
  assert.equal(confirmations.length, 0);
});
test("confirmation errors and cancellation during approval fail closed", async () => {
  const first = setup();
  first.context.ui.confirm = async () => { throw new Error("UI unavailable"); };
  await assert.rejects(first.execute(write), /UI unavailable/);
  const abort = new AbortController();
  const second = setup();
  second.context.ui.confirm = async () => { abort.abort(); return true; };
  await assert.rejects(second.execute(write, abort.signal));
  assert.equal(requests.length, 0);
});
test("session shutdown aborts in-flight and queued work", async () => {
  let started!: () => void;
  const ready = new Promise<void>((resolve) => { started = resolve; });
  globalThis.fetch = async (_url, options) => {
    requests.push({ url: "mock" });
    started();
    return await new Promise<Response>((_resolve, reject) => { options?.signal?.addEventListener("abort", () => reject(options.signal?.reason), { once: true }); });
  };
  const { execute, hooks } = setup();
  const first = execute(read);
  await ready;
  const second = execute(read);
  await hooks.get("session_shutdown")!();
  await Promise.all([assert.rejects(first, /cancelled/), assert.rejects(second, /cancelled/)]);
  assert.equal(requests.length, 1);
});
