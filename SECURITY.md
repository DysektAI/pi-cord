# Security

## Trust boundary

Pi extensions run with the permissions of the Pi process. Install only reviewed
sources. This package sends authenticated requests on behalf of the account you
select; the account's Discord permissions remain the platform access boundary.

Write approval is enforced inside the tool executor, so direct and nested tool
calls must both pass it. No UI means no writes. Approval is not a sandbox: another
extension, shell command, or program can bypass this package entirely. Untrusted
channel content can still influence an agent; never treat a recap as an instruction
or approve an operation without reading its destination and complete body.

No gateway, watcher, scheduler, token discovery, or credential export is provided.
The package reads your existing environment/config only when needed. Keep credentials
outside model context and restrict access to credential files. Exact configured-token
redaction is defense in depth, not a general-purpose detector for other secrets in
messages. Do not ask the agent to post private messages or credentials publicly.

## User-token risk

Discord forbids normal-user-account automation outside its OAuth2/bot APIs, including
read-only and human-directed token requests. Unsupported user-token mode is retained
for compatibility, not endorsed as compliant. It can result in account termination.
Neither rate limiting, human approval, nor a disclaimer changes Discord's policy.
See the [usage notice](README.md#unsupported-user-token-mode-and-acceptable-use).

## Transport limitations

The request queue is per credential in a single runtime, not shared across processes.
Rate-limit waits are conservative and finite. Unknown retry timing fails rather than
inventing a rate-limit bypass. Writes are not automatically replayed after ambiguous
network or server errors. Check Discord before manually retrying an uncertain send.

The response limit bounds retained data and stops stream consumption once exceeded;
the HTTP implementation can still deliver a chunk larger than the retained limit.
Truncated responses must not be interpreted as complete structured data.

## Reporting

Report vulnerabilities privately through the repository's GitHub security reporting
feature when available; otherwise contact the maintainer privately before opening a
public issue. Do not include live tokens, private channel content, or exploit data
against a server you do not control. Public issues are appropriate for non-sensitive
bugs with fake credentials and minimal reproductions.
