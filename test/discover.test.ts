import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import {
  loadInScopeSources,
  type ModelReviewRequest,
  type ReviewModel,
  type RuleContext,
} from "@adversarylabs/sdk";
import { analyzeDiscovery } from "../src/analyze.ts";
import { discoverSources } from "../src/discover.ts";
import { createApp } from "../src/index.ts";

const execute = promisify(execFile);
const ruleId = "go-cli.exit-bypass";

type CapturingModel = ReviewModel & { requests: ModelReviewRequest[] };

test("an unrelated edit excludes a legacy CLI finding and preserves modified model status", async () => {
  const repo = await repositoryWithLegacyExit();
  const path = "cmd/root.go";
  await writeFile(join(repo, path), cliSource("new unrelated diagnostic"));

  const discovery = await discoverSources(changedContext(repo, [path]));
  assert.equal(discovery.files[0]?.status, "modified");
  assert.deepEqual([...discovery.files[0]!.changedLines], [12]);

  const analysis = await analyzeDiscovery(discovery);
  assert.deepEqual(analysis.signals.filter((signal) => signal.ruleId === ruleId), []);

  const model = capturingModel();
  const review = await changedReview(repo, [path], model);
  assert.deepEqual(review.findings.filter((finding) => finding.ruleId === ruleId), []);

  const request = model.requests[0];
  assert.ok(request);
  const source = (request.input as {
    sources: Array<{ path: string; status: string; content: string }>;
  }).sources.find((item) => item.path === path);
  assert.equal(source?.status, "modified");
  assert.match(source?.content ?? "", /os\.Exit\(124\)/);
});

test("an added CLI file remains fully eligible", async () => {
  const repo = await repositoryWithLegacyExit();
  const path = "cmd/added.go";
  await writeFile(join(repo, path), cliSource("added file"));

  const discovery = await discoverSources(changedContext(repo, [path]));
  assert.equal(discovery.files[0]?.status, "added");

  const analysis = await analyzeDiscovery(discovery);
  assert.equal(analysis.signals.filter((signal) => signal.ruleId === ruleId).length, 1);

  const model = capturingModel();
  const review = await changedReview(repo, [path], model);
  assert.equal(review.findings.filter((finding) => finding.ruleId === ruleId).length, 1);
  const request = model.requests[0];
  assert.ok(request);
  const source = (request.input as {
    sources: Array<{ path: string; status: string }>;
  }).sources.find((item) => item.path === path);
  assert.equal(source?.status, "added");
});

async function repositoryWithLegacyExit(): Promise<string> {
  const repo = await mkdtemp(join(tmpdir(), "go-cli-discover-"));
  await execute("git", ["init", "--quiet"], { cwd: repo });
  await execute("git", ["config", "user.email", "tests@example.com"], { cwd: repo });
  await execute("git", ["config", "user.name", "Tests"], { cwd: repo });
  await mkdir(join(repo, "cmd"), { recursive: true });
  await writeFile(join(repo, "cmd/root.go"), cliSource("old diagnostic"));
  await execute("git", ["add", "cmd/root.go"], { cwd: repo });
  await execute("git", ["commit", "--quiet", "-m", "fixture"], { cwd: repo });
  return repo;
}

function cliSource(diagnostic: string): string {
  return `package cmd

import "os"

func run() {
	defer os.Exit(124)
}

func unrelated() {
	println("still unrelated")
	println("another line")
	println(${JSON.stringify(diagnostic)})
}
`;
}

function capturingModel(): CapturingModel {
  const requests: ModelReviewRequest[] = [];
  return {
    requests,
    async review<T>(request: ModelReviewRequest) {
      requests.push(request);
      return {
        output: {
          assessment: { risk: "none", summary: "No new CLI contract issue." },
          ship: true,
          observations: [],
        } as T,
        provider: "fixture",
        model: "change-local",
      };
    },
  };
}

async function changedReview(
  repoPath: string,
  changedFiles: string[],
  model: ReviewModel,
) {
  return createApp().run({
    model,
    input: {
      source: { path: repoPath },
      change: {
        type: "diff",
        base_ref: "HEAD",
        head_ref: "WORKTREE",
        scan_mode: "changed",
        changed_files: changedFiles,
      },
    },
  });
}

function changedContext(repoPath: string, changedFiles: string[]): RuleContext {
  const change: RuleContext["change"] = {
    type: "diff",
    baseRef: "HEAD",
    headRef: "WORKTREE",
    scanMode: "changed",
    changedFiles,
    worktree: true,
  };
  return {
    repoPath,
    change,
    repoIndex: null,
    summary: {},
    cache: new Map(),
    relpath: (path) => path,
    glob: async () => [],
    rglob: async () => [],
    listInScopePaths: async () => [],
    loadInScopeSources: async (options) => loadInScopeSources(repoPath, change, options),
    model: {} as RuleContext["model"],
    observe: () => {},
    finding: () => {},
    review: {
      assessment: () => {},
      positive: () => {},
      observe: () => {},
      score: () => {},
      opinion: () => {},
    },
  };
}
