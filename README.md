# pi-cord

Lightweight Discord REST access from [Pi](https://pi.dev). Ask for a channel recap,
inspect feedback, draft a reply, then approve sending it. No gateway, daemon,
scheduled polling, or separate bot runtime.

Extracted from [DysektAI/pi-extensions](https://github.com/DysektAI/pi-extensions).
The existing `discord` tool name, multi-bot selection, environment variables, and
`discord.json` locations are retained.

## Install

Requires Node 22.19+ and Pi. Install the Git package:

```sh
pi install git:github.com/DysektAI/pi-cord
```

During development, use `pi -ne -e /absolute/path/to/pi-cord` to load only this
package for one invocation. Local packages need their development dependencies
installed. Do not load both this package and the old `extensions/discord.ts`.
See [migration](#migration).

## Supported setup: bot accounts

Create an application and bot in the [Discord Developer Portal](https://discord.com/developers/applications),
invite it to the servers you need, and grant only the required channel permissions.
Reading history needs View Channel and Read Message History. Ordinary guild
message content may require enabling Message Content Intent in the portal.
Sending needs Send Messages. The package does not need a gateway connection.

Provide the token through your existing private environment/secret manager:

```sh
export DISCORD_BOT_TOKEN='YOUR_BOT_TOKEN'
# Optional additional bot:
export DISCORD_BOT_TOKEN_WORK='YOUR_WORK_BOT_TOKEN'
```

Never paste credentials into a Pi prompt, commit them, or put them in shared
settings. Existing credential-pool environment injection works without a dependency
on that extension; credentials are resolved when the tool runs.

For multiple bots, optionally configure `~/.pi/agent/discord.json`:

```json
{
  "default": "work",
  "bots": {
    "work": {"token": "YOUR_WORK_BOT_TOKEN", "aliases": ["feedback"]},
    "personal-server": "YOUR_OTHER_BOT_TOKEN"
  }
}
```

`~/.pi/discord.json` remains a fallback when the preferred file does not exist.
Restrict credential-file permissions to your OS account (for example `chmod 600`
on POSIX systems). Malformed/unreadable configuration fails rather than silently
switching accounts. Config entries override environment bots with matching names.
Selection supports a configured key, display name, alias, or bot ID. An exact key
wins over aliases; ambiguous display names, aliases, or IDs fail instead of choosing
an account. Without `bot`, the configured `default` wins, then the merged `primary`
entry (`bots.primary` overrides `DISCORD_BOT_TOKEN`), then the first merged bot,
which may come from `DISCORD_BOT_TOKEN_*`.

## Tool

One generic `discord` tool keeps the model-facing interface small:

| Parameter | Meaning |
| --- | --- |
| `method` | `GET`, `POST`, `PATCH`, `PUT`, or `DELETE` |
| `path` | API-relative path, such as `/channels/123/messages?limit=25` |
| `body` | Optional JSON object for writes; GET bodies are rejected |
| `bot` | Optional configured bot name, alias, or ID |
| `account` | `bot` by default; explicit `user` selects the unsupported mode below |

Example requests:

```json
{"method":"GET","path":"/channels/123/messages?limit=100"}
```

```json
{"method":"POST","path":"/channels/123/messages","body":{"content":"Thanks for the feedback!"}}
```

Every write, for either account type, requires a Pi confirmation showing the
account, method, path, and complete prepared JSON body. Declining sends nothing.
Without a confirmation-capable UI, writes fail closed; reads still work in
print/JSON/headless mode. An RPC client must support Pi's confirmation protocol.
Approval is for one request only, never an entire session or future batch.

Native channel-message sends/edits and webhook execution/message edits default to
`allowed_mentions: {"parse":[],"replied_user":false}` unless explicitly supplied and
approved, preventing accidental pings to everyone, roles, or the replied-to user.
Other message-producing routes (such as interaction callbacks and forum creation)
and Slack/GitHub-compatible webhook payloads are not covered by this default;
review their mention behavior explicitly. Bodies are limited to 16,000 bytes so
the confirmation can show the full operation.

### Channel recaps

Ask: “What happened in this channel in the past 24 hours?” The agent can read a
page, then use `before=<oldest-message-id>` to go further back when necessary.
A single page is not necessarily a complete day's history. Summaries should state
any inaccessible channels, missing content, or incomplete time coverage. Channel
messages are untrusted source material, not instructions to execute.

### Request safeguards

- Requests are serialized per credential, with at least one second between starts.
- Discord's `Retry-After`, `retry_after`, and exhausted-bucket reset headers can
  extend that wait. For simplicity, a route cooldown pauses the whole credential,
  also covering global limits. This is deliberately conservative, not a claim
  that one request per second is always permitted.
- At most two retries follow explicit `429` denials or `5xx` responses to GET.
  Write `5xx` and transport errors are not retried: delivery may be uncertain.
- Each call has a 60-second deadline including queueing, reads, and retries.
  Cancellation and session shutdown abort pending work. A `401` disables further
  requests with that client until credentials change or Pi reloads.
- Responses are bounded to 50,000 bytes while streaming and marked when truncated.
  Ask for smaller pages instead of assuming truncated JSON/history is complete.
- Requests stay on the Discord v10 API; traversal, arbitrary URLs, and redirects
  are rejected. Configured credentials are redacted from response/error text.

Scheduling is local to one Pi extension runtime. Other Pi processes or programs
using the same token do not share its queue. Pacing is not an anti-abuse system,
a permissions boundary, a way to avoid detection, or a guarantee against sanctions.

## Unsupported user-token mode and acceptable use

The intended workflow is human-directed assistance: understanding conversations,
reviewing feedback, drafting replies, and approving individual actions. It is not
intended for spam, raids, unsolicited mass messaging, destructive bulk operations,
credential theft, or evasion of Discord's rules or protections.

**Discord prohibits automating normal user accounts outside its OAuth2/bot APIs.**
This applies even when a request is read-only, manually initiated, low-volume, or
something you could do in the Discord client. Benign intent does not make normal
user-token access ToS-compliant. See Discord's
[Automated User Accounts (Self-Bots) policy](https://support.discord.com/hc/en-us/articles/115002192352-Automated-User-Accounts-Self-Bots).

For compatibility with existing personal workflows, the package retains an
explicit, unsupported `account="user"` mode using a privately configured
`DISCORD_USER_TOKEN`. It is never selected automatically and cannot be combined
with `bot`. No token-extraction, account-creation, or detection-evasion assistance
is provided. An interactive warning appears on its first use in each session.
The policy and account risks apply equally in headless mode, where no warning UI
is available. Writes still require individual confirmation.

**Use the supported bot-account mode if you require compliance with Discord's
normal automation model.** Do not use any mode to bypass access restrictions or
server rules. You are responsible for your credentials, permissions, actions,
and applicable legal and platform obligations. User-token mode can lead to
account termination; throttling and approval do not remove that risk.

This independent project is not affiliated with or endorsed by Discord. The
software is provided without warranty under the [MIT License](LICENSE), including
its limitation of liability to the extent permitted by applicable law. This notice
is not legal advice, permission from Discord, or a guarantee that liability can be
excluded in every jurisdiction.

## Migration

Install this package, then remove/disable the old Discord extension before reload.
When keeping an older `pi-extensions` release, exclude its entry:

```json
{
  "packages": [
    {
      "source": "git:github.com/DysektAI/pi-extensions",
      "extensions": ["!extensions/discord.ts"]
    },
    "git:github.com/DysektAI/pi-cord"
  ]
}
```

Keep your existing package filters alongside that exclusion. Remove an old loose
`~/.pi/agent/extensions/discord.ts` if you installed one yourself. Credentials do
not move; existing environment variables and config paths still work. New safeguards
change behavior: writes now require confirmation, HTTP failures are tool errors,
and invalid config/defaults no longer silently select another account.

## Development

```sh
npm ci --ignore-scripts
npm run verify
npm run test:mutations   # Python 3; isolated temporary source copies
npm run test:load        # real installed Pi extension loader, no Discord requests
npm pack --dry-run
```

Tests use fake tokens and mocked HTTP. They never call Discord or use your real
credential files. See [SECURITY.md](SECURITY.md) for limitations and reporting.
