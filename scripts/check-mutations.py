#!/usr/bin/env python3
"""Prove critical guards are observable by isolated regression tests."""
from pathlib import Path
import shutil
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[1]
MUTATIONS = [
    ("write approval", "src/index.ts", 'if (method !== "GET") {', 'if (false) {', "writes require approval inside execute"),
    ("headless denial", "src/index.ts", 'if (!ctx.hasUI) throw new Error', 'if (false) throw new Error', "no UI means no write"),
    ("mention protection", "src/index.ts", 'body.allowed_mentions ??= { parse: [], replied_user: false };', '/* mutation: no mention protection */', "approval sends prepared body"),
    ("request snapshot", "src/index.ts", '{ method, path, body }, operationSignal', '{ method, path: params.path, body }, operationSignal', "full request cannot change"),
    ("rate-limit wait", "src/client.ts", 'if (delay) await this.runtime.sleep(delay, signal);', '/* mutation: no cooldown */', "429 uses longest"),
    ("HTTP failure", "src/client.ts", 'if (!response.ok) throw new Error', 'if (false) throw new Error', "HTTP errors fail"),
    ("write retry safety", "src/client.ts", 'request.method === "GET" && attempt < MAX_RETRIES', 'attempt < MAX_RETRIES', "only GET retries"),
    ("origin/path guard", "src/client.ts", 'throw new Error("Discord path cannot contain traversal or control characters.");', '/* mutation: accept traversal */', "rejects arbitrary URL"),
    ("response byte bound", "src/client.ts", 'const MAX_RESPONSE_BYTES = 50_000;', 'const MAX_RESPONSE_BYTES = 100_000;', "bounds streaming bytes"),
    ("minimum pacing", "src/client.ts", 'const MIN_INTERVAL_MS = 1_000;', 'const MIN_INTERVAL_MS = 0;', "serializes concurrent"),
    ("deadline budget", "src/client.ts", 'const REQUEST_TIMEOUT_MS = 60_000;', 'const REQUEST_TIMEOUT_MS = 61_000;', "deadline covers"),
    ("rejected-token latch", "src/client.ts", 'if (response.status === 401) this.unauthorized = true;', '/* mutation: reuse rejected token */', "HTTP errors fail"),
    ("credential redaction", "src/client.ts", 'text.split(token).join("[redacted]")', 'text', "redacts exact credential"),
    ("user authentication compatibility", "src/auth.ts", 'Authorization: userToken', 'Authorization: `Bot ${userToken}`', "user access is explicit"),
    ("default-account safety", "src/auth.ts", 'if (!found) throw new Error("Configured default Discord bot does not exist; no fallback account was selected.");', 'if (!found) return bots.get("primary")!;', "does not silently fall back"),
    ("ambiguous-account safety", "src/auth.ts", 'if (matches.length > 1) throw new Error', 'if (false) throw new Error', "ambiguous bot aliases"),
    ("webhook mention protection", "src/index.ts", 'if (body && messageWrite) {', 'if (body && messageWrite && pathname.includes("/channels/")) {', "webhook message writes"),
]

with tempfile.TemporaryDirectory(prefix="pi-cord-mutations-") as temp:
    checkout = Path(temp)
    for directory in ("src", "test"):
        shutil.copytree(ROOT / directory, checkout / directory)
    shutil.copy2(ROOT / "package.json", checkout / "package.json")
    (checkout / "node_modules").symlink_to(ROOT / "node_modules", target_is_directory=True)
    for label, relative, before, after, pattern in MUTATIONS:
        target = checkout / relative
        original = target.read_text()
        if original.count(before) != 1:
            raise SystemExit(f"Mutation target must match exactly once: {label}")
        target.write_text(original.replace(before, after))
        result = subprocess.run(["node", "--experimental-strip-types", "--test", "--test-reporter=tap", f"--test-name-pattern={pattern}", *map(str, sorted((checkout / "test").glob("*.test.ts")))], cwd=checkout, capture_output=True, text=True, timeout=15)
        target.write_text(original)
        if result.returncode == 0 or "not ok" not in result.stdout or "ERR_ASSERTION" not in result.stdout or "ERR_MODULE_NOT_FOUND" in result.stderr:
            print(result.stdout, result.stderr)
            raise SystemExit(f"Regression did not detect mutation: {label}")
        print(f"Detected: {label}")
print(f"All {len(MUTATIONS)} mutations detected by assertions.")
