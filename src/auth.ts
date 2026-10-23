import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export interface BotEntry {
  token: string;
  id?: string;
  name?: string;
  aliases?: string[];
}
export interface DiscordConfig {
  default?: string;
  bots?: Record<string, string | BotEntry>;
}
export interface ResolvedBot {
  token: string;
  id?: string;
  name: string;
  aliases: string[];
}
export type Account = "bot" | "user";
type Env = Record<string, string | undefined>;

export function extractBotId(token: string): string | undefined {
  const decoded = Buffer.from(token.split(".")[0] ?? "", "base64").toString("utf8");
  return /^\d{16,21}$/.test(decoded) ? decoded : undefined;
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function token(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value === value.trim() && !/[\s\u0000-\u001f\u007f]/.test(value);
}

export function validateConfig(value: unknown): DiscordConfig {
  if (!object(value) || (value.default !== undefined && (typeof value.default !== "string" || !value.default.trim())) || (value.bots !== undefined && !object(value.bots))) {
    throw new Error("Invalid Discord configuration: expected an object with optional default and bots fields.");
  }
  for (const [name, entry] of Object.entries(value.bots ?? {})) {
    if (!name.trim() || (typeof entry === "string" ? !token(entry) : !object(entry) || !token(entry.token) ||
      (entry.id !== undefined && (typeof entry.id !== "string" || !/^\d{16,21}$/.test(entry.id))) ||
      (entry.name !== undefined && (typeof entry.name !== "string" || !entry.name.trim())) ||
      (entry.aliases !== undefined && (!Array.isArray(entry.aliases) || !entry.aliases.every((alias) => typeof alias === "string" && !!alias.trim()))))) {
      throw new Error("Invalid Discord bot entry: check token, name, id, and aliases (credentials are not printed).");
    }
  }
  return value as DiscordConfig;
}

export function loadConfig(home = os.homedir()): DiscordConfig | null {
  for (const file of [path.join(home, ".pi", "agent", "discord.json"), path.join(home, ".pi", "discord.json")]) {
    let text: string;
    try { text = fs.readFileSync(file, "utf8"); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw new Error("Discord configuration could not be read; correct its permissions before continuing.");
    }
    let parsed: unknown;
    try { parsed = JSON.parse(text); }
    catch { throw new Error("Discord configuration is not valid JSON; no fallback account was selected."); }
    return validateConfig(parsed);
  }
  return null;
}

export function resolveBot(botName?: string, config: DiscordConfig | null = loadConfig(), env: Env = process.env): ResolvedBot {
  if (config) validateConfig(config);
  const bots = new Map<string, ResolvedBot>();
  const add = (name: string, value: string | BotEntry, aliases: string[] = []) => {
    const entry = typeof value === "string" ? { token: value } : value;
    if (!token(entry.token)) throw new Error("Invalid Discord bot token configuration (credentials are not printed).");
    bots.set(name.toLowerCase(), {
      token: entry.token,
      id: entry.id ?? extractBotId(entry.token),
      name: entry.name ?? name,
      aliases: (entry.aliases ?? aliases).map((alias) => alias.trim().toLowerCase()),
    });
  };
  if (env.DISCORD_BOT_TOKEN) add("primary", env.DISCORD_BOT_TOKEN, ["default"]);
  for (const [key, value] of Object.entries(env)) {
    if (key.startsWith("DISCORD_BOT_TOKEN_") && value) add(key.slice("DISCORD_BOT_TOKEN_".length).toLowerCase(), value);
  }
  for (const [name, entry] of Object.entries(config?.bots ?? {})) add(name, entry);
  if (!bots.size) throw new Error("No Discord bots configured. Set DISCORD_BOT_TOKEN or configure ~/.pi/agent/discord.json.");
  const find = (query: string) => {
    const search = query.trim().toLowerCase();
    const direct = bots.get(search);
    if (direct) return direct;
    const matches = [...bots.values()].filter((bot) => bot.id === search || bot.name.toLowerCase() === search || bot.aliases.includes(search));
    if (matches.length > 1) throw new Error("Ambiguous Discord bot selector; use a unique configured key instead of a shared name, alias, or ID.");
    return matches[0];
  };
  if (botName !== undefined) {
    const found = find(botName);
    if (!found) throw new Error("Unknown Discord bot; use a configured name, alias, or ID.");
    return found;
  }
  if (config?.default !== undefined) {
    const found = find(config.default);
    if (!found) throw new Error("Configured default Discord bot does not exist; no fallback account was selected.");
    return found;
  }
  return bots.get("primary") ?? bots.values().next().value!;
}

export function resolveAuth(account: Account, botName?: string): { headers: Record<string, string>; bot?: ResolvedBot } {
  if (account === "user") {
    if (botName !== undefined) throw new Error('The "bot" argument cannot be combined with account="user".');
    const userToken = process.env.DISCORD_USER_TOKEN;
    if (!token(userToken)) throw new Error("DISCORD_USER_TOKEN is missing or invalid. User-token mode is unsupported and risks account termination.");
    return { headers: { Authorization: userToken } };
  }
  if (account !== "bot") throw new Error("Discord account must be bot or user.");
  const bot = resolveBot(botName);
  return { headers: { Authorization: `Bot ${bot.token}` }, bot };
}
