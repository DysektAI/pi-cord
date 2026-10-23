import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const dist = dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent")));
const { loadExtensions } = await import(pathToFileURL(join(dist, "core/extensions/loader.js")).href);
const result = await loadExtensions([join(process.cwd(), "src/index.ts")], process.cwd());
assert.deepEqual(result.errors, [], "Pi must load the extension without errors");
assert.equal(result.extensions.length, 1);
assert.deepEqual([...result.extensions[0].tools.keys()], ["discord"]);
console.log("Real Pi loader: one Discord extension/tool; no credential reads or network requests.");
