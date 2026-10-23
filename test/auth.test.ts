import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { extractBotId, loadConfig, resolveAuth, resolveBot, validateConfig } from "../src/auth.ts";

let home: string;
let saved: Record<string, string | undefined>;
beforeEach(() => {
  saved = { ...process.env };
  for (const key of Object.keys(process.env)) if (key.startsWith("DISCORD_")) delete process.env[key];
  home = mkdtempSync(join(tmpdir(), "pi-discord-test-"));
  process.env.HOME = home;
  process.env.USERPROFILE = home;
});
afterEach(() => {
  for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
  Object.assign(process.env, saved);
  rmSync(home, { recursive: true, force: true });
});

const id = "123456789012345678";
const idToken = `${Buffer.from(id).toString("base64")}.fake.token`;
test("extracts bot ID and defaults to primary with Bot prefix", () => {
  assert.equal(extractBotId(idToken), id);
  assert.equal(extractBotId("fake-token"), undefined);
  process.env.DISCORD_BOT_TOKEN = idToken;
  assert.equal(resolveAuth("bot").headers.Authorization, `Bot ${idToken}`);
  assert.equal(resolveAuth("bot").bot?.id, id);
});
test("selects multiple bots by default, name, alias and ID; config overrides env", () => {
  const config = { default: "main", bots: { work: { token: idToken, name: "Work Bot", aliases: ["Main"] } } };
  const env = { DISCORD_BOT_TOKEN: "primary-token", DISCORD_BOT_TOKEN_WORK: "env-token", DISCORD_BOT_TOKEN_OTHER: "other-token" };
  for (const query of [undefined, "work", " Work Bot ", "MAIN", id]) assert.equal(resolveBot(query, config, env).token, idToken);
  assert.equal(resolveBot("other", config, env).token, "other-token");
  assert.equal(resolveBot(undefined, null, env).token, "primary-token");
  assert.equal(resolveBot(undefined, { bots: { first: "first-token" } }, {}).name, "first");
});
test("does not silently fall back for a missing configured default", () => {
  assert.throws(() => resolveBot(undefined, { default: "missing", bots: { work: "fake-token" } }, { DISCORD_BOT_TOKEN: "other-token" }), /default.*does not exist/);
  assert.throws(() => resolveBot("missing", null, { DISCORD_BOT_TOKEN: "fake-token" }), /Unknown Discord bot/);
  assert.throws(() => resolveBot(undefined, null, {}), /No Discord bots/);
});
test("rejects malformed config without including its credentials", () => {
  for (const config of [null, [], { bots: [] }, { default: 42 }, { bots: { work: { token: "secret-token", aliases: [42] } } }, { bots: { work: " secret-token " } }]) {
    assert.throws(() => validateConfig(config), (error: Error) => !error.message.includes("secret-token"));
  }
});
test("reads preferred/fallback config and rejects malformed preferred file", () => {
  const fallback = join(home, ".pi", "discord.json");
  const preferred = join(home, ".pi", "agent", "discord.json");
  mkdirSync(join(home, ".pi", "agent"), { recursive: true });
  writeFileSync(fallback, JSON.stringify({ bots: { fallback: "fallback-token" } }));
  assert.equal(loadConfig()?.bots?.fallback, "fallback-token");
  writeFileSync(preferred, JSON.stringify({ bots: { primary: "primary-token" } }));
  assert.equal(loadConfig()?.bots?.primary, "primary-token");
  writeFileSync(preferred, '{"token":"secret-token"');
  assert.throws(() => loadConfig(), /not valid JSON/);
});
test("user access is explicit, keeps unprefixed token, and rejects bot combinations", () => {
  assert.throws(() => resolveAuth("user"), /DISCORD_USER_TOKEN.*missing/);
  process.env.DISCORD_USER_TOKEN = "fake-user-token";
  process.env.DISCORD_BOT_TOKEN = "fake-bot-token";
  assert.equal(resolveAuth("user").headers.Authorization, "fake-user-token");
  assert.equal(resolveAuth("bot").headers.Authorization, "Bot fake-bot-token");
  assert.throws(() => resolveAuth("user", "work"), /cannot be combined/);
  assert.throws(() => resolveAuth("user", ""), /cannot be combined/);
  process.env.DISCORD_USER_TOKEN = "bad\ntoken";
  assert.throws(() => resolveAuth("user"), /missing or invalid/);
  assert.throws(() => resolveAuth("other" as "bot"), /must be bot or user/);
});
