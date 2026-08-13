import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { loadInScopeSources, type RuleContext } from "@adversarylabs/sdk";
import { analyzeDiscovery } from "../src/analyze.ts";
import { discoverSources } from "../src/discover.ts";

const execute = promisify(execFile);
const ruleId = "go-cli.cobra-positional-args-minimum";

test("a legacy unsafe callback stays quiet for an unrelated edit but fires when its access changes", async () => {
  const repo = await mkdtemp(join(tmpdir(), "go-cli-cobra-locality-"));
  const path = "cmd/search.go";
  await execute("git", ["init", "--quiet"], { cwd: repo });
  await execute("git", ["config", "user.email", "tests@example.com"], { cwd: repo });
  await execute("git", ["config", "user.name", "Tests"], { cwd: repo });
  await mkdir(join(repo, "cmd"), { recursive: true });
  await writeFile(join(repo, path), source("return search(args[0])", "old diagnostic"));
  await execute("git", ["add", path], { cwd: repo });
  await execute("git", ["commit", "--quiet", "-m", "fixture"], { cwd: repo });

  await writeFile(join(repo, path), source("return search(args[0])", "new diagnostic"));
  let discovery = await discoverSources(changedContext(repo, [path]));
  let analysis = await analyzeDiscovery(discovery);
  assert.deepEqual(analysis.signals.filter((signal) => signal.ruleId === ruleId), []);

  await writeFile(join(repo, path), source("return search((args[0]))", "old diagnostic"));
  discovery = await discoverSources(changedContext(repo, [path]));
  analysis = await analyzeDiscovery(discovery);
  const found = analysis.signals.filter((signal) => signal.ruleId === ruleId);
  assert.equal(found.length, 1);
  assert.equal(found[0]?.snippet, "args[0]");
});

test("weakening a validator is anchored to the changed validator rather than legacy access", async () => {
  const repo = await mkdtemp(join(tmpdir(), "go-cli-cobra-validator-locality-"));
  const path = "cmd/search.go";
  await execute("git", ["init", "--quiet"], { cwd: repo });
  await execute("git", ["config", "user.email", "tests@example.com"], { cwd: repo });
  await execute("git", ["config", "user.name", "Tests"], { cwd: repo });
  await mkdir(join(repo, "cmd"), { recursive: true });
  await writeFile(join(repo, path), sourceWithValidator("cobra.ExactArgs(1)"));
  await execute("git", ["add", path], { cwd: repo });
  await execute("git", ["commit", "--quiet", "-m", "fixture"], { cwd: repo });

  await writeFile(join(repo, path), sourceWithValidator("cobra.MaximumNArgs(1)"));
  const discovery = await discoverSources(changedContext(repo, [path]));
  const analysis = await analyzeDiscovery(discovery);
  const found = analysis.signals.filter((signal) => signal.ruleId === ruleId);
  assert.equal(found.length, 1);
  assert.equal(found[0]?.snippet, "cobra.MaximumNArgs(1)");
  assert.equal(found[0]?.data.access, "args[0]");
});

test("a comment-only validator edit does not activate a legacy unsafe access", async () => {
  for (const [name, fixture] of [
    ["multiline", sourceWithMultilineValidatorComment],
    ["trailing", sourceWithTrailingValidatorComment],
  ] as const) {
    const repo = await mkdtemp(join(tmpdir(), `go-cli-cobra-${name}-comment-locality-`));
    const path = "cmd/search.go";
    await execute("git", ["init", "--quiet"], { cwd: repo });
    await execute("git", ["config", "user.email", "tests@example.com"], { cwd: repo });
    await execute("git", ["config", "user.name", "Tests"], { cwd: repo });
    await mkdir(join(repo, "cmd"), { recursive: true });
    await writeFile(join(repo, path), fixture("old wording"));
    await execute("git", ["add", path], { cwd: repo });
    await execute("git", ["commit", "--quiet", "-m", "fixture"], { cwd: repo });

    await writeFile(join(repo, path), fixture("new wording"));
    const discovery = await discoverSources(changedContext(repo, [path]));
    const analysis = await analyzeDiscovery(discovery);
    assert.deepEqual(analysis.signals.filter((signal) => signal.ruleId === ruleId), [], name);
  }
});

test("changed guard and reassignment lines can anchor a legacy unsafe access", async () => {
  for (const fixture of [
    {
      prefix: "guard",
      before: sourceWithFlow('if len(args) == 0 { return errors.New("missing") }')
        .replace("cobra.ExactArgs(1)", "cobra.MaximumNArgs(1)"),
      after: sourceWithFlow('if len(args) < 0 { return errors.New("missing") }')
        .replace("cobra.ExactArgs(1)", "cobra.MaximumNArgs(1)"),
      snippet: "len(args) < 0",
    },
    {
      prefix: "assignment",
      before: sourceWithFlow('args = []string{"safe"}'),
      after: sourceWithFlow("args = maybeEmpty(args)"),
      snippet: "args = maybeEmpty(args)",
    },
  ]) {
    const repo = await mkdtemp(join(tmpdir(), `go-cli-cobra-${fixture.prefix}-locality-`));
    const path = "cmd/search.go";
    await execute("git", ["init", "--quiet"], { cwd: repo });
    await execute("git", ["config", "user.email", "tests@example.com"], { cwd: repo });
    await execute("git", ["config", "user.name", "Tests"], { cwd: repo });
    await mkdir(join(repo, "cmd"), { recursive: true });
    await writeFile(join(repo, path), fixture.before);
    await execute("git", ["add", path], { cwd: repo });
    await execute("git", ["commit", "--quiet", "-m", "fixture"], { cwd: repo });
    await writeFile(join(repo, path), fixture.after);

    const discovery = await discoverSources(changedContext(repo, [path]));
    const analysis = await analyzeDiscovery(discovery);
    const found = analysis.signals.filter((signal) => signal.ruleId === ruleId);
    assert.equal(found.length, 1, fixture.prefix);
    assert.equal(found[0]?.snippet, fixture.snippet, fixture.prefix);
  }
});

function source(access: string, diagnostic: string): string {
  return `package cmd

import "github.com/spf13/cobra"

func newSearchCommand() *cobra.Command {
	return &cobra.Command{
		Use: "search [vulnerability_id]",
		Args: cobra.MaximumNArgs(1),
		RunE: func(_ *cobra.Command, args []string) error {
			${access}
		},
	}
}

func note() { println(${JSON.stringify(diagnostic)}) }
`;
}

function sourceWithValidator(validator: string): string {
  return `package cmd

import "github.com/spf13/cobra"

func newSearchCommand() *cobra.Command {
	return &cobra.Command{
		Use: "search [vulnerability_id]",
		Args: ${validator},
		RunE: func(_ *cobra.Command, args []string) error {
			return search(args[0])
		},
	}
}
`;
}

function sourceWithMultilineValidatorComment(comment: string): string {
  return `package cmd

import "github.com/spf13/cobra"

func newSearchCommand() *cobra.Command {
	return &cobra.Command{
		Args: cobra.MaximumNArgs(
			1,
			// ${comment}
		),
		RunE: func(_ *cobra.Command, args []string) error { return search(args[0]) },
	}
}
`;
}

function sourceWithTrailingValidatorComment(comment: string): string {
  return `package cmd

import "github.com/spf13/cobra"

func newSearchCommand() *cobra.Command {
	return &cobra.Command{
		Args: cobra.MaximumNArgs(1), // ${comment}
		RunE: func(_ *cobra.Command, args []string) error { return search(args[0]) },
	}
}
`;
}

function sourceWithFlow(statement: string): string {
  return `package cmd

import (
	"errors"
	"github.com/spf13/cobra"
)

func newSearchCommand() *cobra.Command {
	return &cobra.Command{
		Args: cobra.ExactArgs(1),
		RunE: func(_ *cobra.Command, args []string) error {
			${statement}
			return search(args[0])
		},
	}
}
`;
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
