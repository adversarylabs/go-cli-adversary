import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { normalizeChangeContext } from "@adversarylabs/sdk";
import { discoverSources } from "../src/discover.ts";

const CLEAN_MAIN = `package main

func main() {
}
`;

const EXITING_MAIN = `package main

import "os"

func main() {
	os.Exit(1)
}
`;

async function repositoryWithTwoCommits(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "go-cli-discover-"));
  git(root, "init", "-b", "main");
  await mkdir(join(root, "cmd", "first"), { recursive: true });
  await writeFile(join(root, "cmd", "first", "main.go"), EXITING_MAIN);
  git(root, "add", ".");
  git(root, "commit", "-m", "first");
  await mkdir(join(root, "cmd", "second"), { recursive: true });
  await writeFile(join(root, "cmd", "second", "main.go"), CLEAN_MAIN);
  git(root, "add", ".");
  git(root, "commit", "-m", "second");
  return root;
}

function git(root: string, ...args: string[]): void {
  execFileSync("git", [
    "-C", root,
    "-c", "user.name=test",
    "-c", "user.email=test@example.com",
    "-c", "commit.gpgsign=false",
    ...args,
  ]);
}

test("a null change reviews the entire repository", async () => {
  const root = await repositoryWithTwoCommits();
  const discovery = await discoverSources(root, null);
  assert.equal(discovery.mode, "repository");
  assert.deepEqual(discovery.files.map((file) => file.path).sort(), [
    "cmd/first/main.go",
    "cmd/second/main.go",
  ]);
});

test("scan mode all reviews the entire repository despite an available diff", async () => {
  const root = await repositoryWithTwoCommits();
  const discovery = await discoverSources(root, normalizeChangeContext({
    scan_mode: "all",
    base_ref: "HEAD~1",
    head_ref: "HEAD",
  }));
  assert.equal(discovery.mode, "repository");
  assert.equal(discovery.files.length, 2);
});

test("scan mode changed reviews the provided base range only", async () => {
  const root = await repositoryWithTwoCommits();
  const discovery = await discoverSources(root, normalizeChangeContext({
    scan_mode: "changed",
    base_ref: "HEAD~1",
    head_ref: "HEAD",
  }));
  assert.equal(discovery.mode, "diff");
  assert.equal(discovery.base, "HEAD~1");
  assert.deepEqual(discovery.files.map((file) => file.path), ["cmd/second/main.go"]);
});

test("the worktree change reviews uncommitted changes against the base", async () => {
  const root = await repositoryWithTwoCommits();
  await writeFile(join(root, "cmd", "second", "main.go"), EXITING_MAIN);
  const discovery = await discoverSources(root, normalizeChangeContext({
    scan_mode: "changed",
    base_ref: "HEAD",
    head_ref: "WORKTREE",
  }));
  assert.equal(discovery.mode, "diff");
  assert.deepEqual(discovery.files.map((file) => file.path), ["cmd/second/main.go"]);
});

test("an unresolvable base falls back to the entire repository", async () => {
  const root = await repositoryWithTwoCommits();
  const discovery = await discoverSources(root, normalizeChangeContext({
    scan_mode: "changed",
    base_ref: "origin/missing",
    head_ref: "HEAD",
  }));
  assert.equal(discovery.mode, "repository");
  assert.equal(discovery.files.length, 2);
});
