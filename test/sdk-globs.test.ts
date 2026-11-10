import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";

const sdkRequire = createRequire(new URL("../node_modules/@earendil-works/pi-coding-agent/package.json", import.meta.url));
const sdkModule = (name: string) => pathToFileURL(sdkRequire.resolve(`./dist/core/${name}.js`)).href;

test("SDK minimatch override keeps the patched matcher in the lock and installed graph", () => {
  const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(manifest.overrides?.["@earendil-works/pi-coding-agent@1.5.2"]?.minimatch, "11.0.1");
  assert.equal(manifest.overrides?.["@earendil-works/pi-coding-agent@1.5.2"]?.["@isaacs/nonrecursive-glob-match"], "1.0.1");
  const lock = JSON.parse(readFileSync(new URL("../package-lock.json", import.meta.url), "utf8"));
  const resolutions = Object.entries(lock.packages as Record<string, { version?: string }>).filter(([name]) => name === "node_modules/minimatch" || name.endsWith("/node_modules/minimatch"));
  assert.ok(resolutions.length > 0, "The SDK must resolve a patched minimatch dependency");
  for (const [, entry] of resolutions) assert.equal(entry.version, "11.0.1");
  assert.equal(sdkRequire("minimatch/package.json").version, "11.0.1");
  const matcherRequire = createRequire(sdkRequire.resolve("minimatch/package.json"));
  assert.equal(matcherRequire("@isaacs/nonrecursive-glob-match/package.json").version, "1.0.1");
});

test("SDK matcher bounds globstar-parent preprocessing without losing ordinary matches", () => {
  const { Minimatch } = sdkRequire("minimatch");
  const pattern = Array(10).fill("**/../a/b").join("/");
  const bounded = new Minimatch(pattern, { optimizationLevel: 2, braceExpandMax: 64 });
  assert.equal(bounded.set.length, 64);
  const ordinary = new Minimatch("**/../a/b/**/../c/d", { optimizationLevel: 2 });
  assert.equal(ordinary.match("../a/b/../c/d"), true);
  assert.equal(ordinary.match("x/a/b/y/c/d"), true);
  assert.equal(ordinary.match("x/a/b/y/c/no-match"), false);
});

test("real SDK package filters preserve nested includes and exclusions", async () => {
  const { DefaultPackageManager } = await import(sdkModule("package-manager"));
  const { SettingsManager } = await import(sdkModule("settings-manager"));
  const root = mkdtempSync(join(tmpdir(), "pi-cord-sdk-globs-"));
  try {
    const packageRoot = join(root, "fixture");
    mkdirSync(packageRoot);
    const entries = [".hidden.ts", "keep.ts", "nested/keep.js", "nested/disabled.ts"];
    writeFileSync(join(packageRoot, "package.json"), JSON.stringify({ name: "local-sdk-glob-fixture", pi: { extensions: entries.map((name) => `extensions/${name}`) } }));
    for (const name of entries) {
      const path = join(packageRoot, "extensions", name);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, "export default () => {};\n");
    }
    const settingsManager = SettingsManager.inMemory({ packages: [{ source: packageRoot, extensions: ["extensions/**/*.{ts,js}", "!**/disabled.*"] }] }, { projectTrusted: true });
    const manager = new DefaultPackageManager({ cwd: root, agentDir: join(root, "agent"), settingsManager });
    const resolved = await manager.resolve();
    assert.deepEqual(resolved.extensions.map((entry: { path: string; enabled: boolean }) => [relative(packageRoot, entry.path).split("\\").join("/"), entry.enabled]).sort(), [
      ["extensions/.hidden.ts", false],
      ["extensions/keep.ts", true],
      ["extensions/nested/disabled.ts", false],
      ["extensions/nested/keep.js", true],
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("SDK matcher preserves glob syntax and repeated-path cache isolation", () => {
  const { minimatch } = sdkRequire("minimatch");
  const cases: Array<[string, string, boolean]> = [
    ["extensions/nested/keep.ts", "extensions/**/*.{ts,js}", true],
    ["extensions/nested/keep.ts", "extensions/*.ts", false],
    ["extensions/nested/keep.ts", "**/+(keep|other).ts", true],
    ["extensions/nested/keep.ts", "**/!(keep).ts", false],
    ["extensions/nested/keep.ts", "**/[ko]*.ts", true],
    ["extensions/.hidden.ts", "**/*.ts", false],
    ["literal*.ts", "literal\\*.ts", true],
    ["literal-other.ts", "literal\\*.ts", false],
  ];
  for (let iteration = 0; iteration < 2; iteration++) {
    for (const [path, pattern, expected] of cases) assert.equal(minimatch(path, pattern), expected, `${path}: ${pattern}`);
  }
});

test("real SDK model scopes preserve case-insensitive provider and model globs", async () => {
  const { resolveModelScopeFromModels } = await import(sdkModule("model-resolver"));
  const models = [
    { provider: "provider-a", id: "model-small", name: "Small" },
    { provider: "provider-a", id: "model-large", name: "Large" },
    { provider: "provider-b", id: "other-small", name: "Other" },
  ];
  const result = resolveModelScopeFromModels(["PROVIDER-A/model-*", "other-?mall"], models);
  assert.deepEqual(result.scopedModels.map((entry: { model: { id: string } }) => entry.model.id), ["model-small", "model-large", "other-small"]);
  assert.deepEqual(result.diagnostics, []);
  assert.deepEqual(resolveModelScopeFromModels(["missing-*"], models).scopedModels, []);
});
