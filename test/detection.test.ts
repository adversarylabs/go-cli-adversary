import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { parseAdversaryManifest } from "@adversarylabs/sdk";

test("declares automatic detection through the canonical manifest", async () => {
  const source = await readFile(new URL("../adversary.yaml", import.meta.url), "utf8");
  const manifest = parseAdversaryManifest(source);
  const files = manifest.detection?.files;

  assert.ok(files !== undefined && files.length > 0);
  assert.deepEqual(files, manifest.triggers?.files_changed);
  assert.ok(files.includes("**/cmd/**/*.go"), "nested command packages must activate go-cli");
  assert.ok(files.includes("**/cli/**/*.go"), "nested CLI packages must activate go-cli");
  assert.equal(manifest.detection?.entrypoint, undefined);
});
