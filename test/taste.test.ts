import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createApp } from "../src/index.ts";
import {
  isNonProductPath,
  isProcessBoundaryExit,
  isRootSignalBootstrap,
  pathPriority,
} from "../src/paths.ts";

test("path taste prefers command entrypoints over scripts and libraries", () => {
  assert.ok(pathPriority("main.go") < pathPriority("internal/app/run.go"));
  assert.ok(pathPriority("cmd/root.go") < pathPriority("pkg/util/util.go"));
  assert.ok(isNonProductPath("scripts/verify-ci-contract.go"));
  assert.ok(isNonProductPath("tools/cmd/download/main.go"));
  assert.ok(isNonProductPath("internal/testdata/sample.go"));
  assert.equal(isNonProductPath("cmd/root.go"), false);
});

test("process-boundary exit mapping is not an exit bypass", () => {
  assert.equal(
    isProcessBoundaryExit("os.Exit(cmd.ExitCode(err))", "main.go"),
    true,
  );
  assert.equal(isProcessBoundaryExit("os.Exit(ExitCode(err))", "main.go"), true);
  assert.equal(isProcessBoundaryExit("defer os.Exit(124)", "main.go"), false);
  assert.equal(isProcessBoundaryExit("log.Fatal(err)", "main.go"), false);
  assert.equal(isProcessBoundaryExit("os.Exit(0)", "main.go"), true);
  assert.equal(isProcessBoundaryExit("os.Exit(1)", "main.go"), true);
  assert.equal(
    isProcessBoundaryExit("os.Exit(cmd.ExitCode(err))", "internal/cli/run.go"),
    false,
  );
});

test("signal.NotifyContext(context.Background()) is root bootstrap, not a cancel hole", () => {
  assert.equal(
    isRootSignalBootstrap(
      "ctx, stop := signal.NotifyContext(context.Background(), processSignals()...)",
      "",
    ),
    true,
  );
  assert.equal(
    isRootSignalBootstrap(
      "ctx := context.Background()",
      "func run(cmd *cobra.Command) {\n\tctx := context.Background()\n",
    ),
    false,
  );
});

async function writeTree(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "go-cli-taste-"));
  for (const [relative, content] of Object.entries(files)) {
    const absolute = join(root, relative);
    await mkdir(join(absolute, ".."), { recursive: true });
    await writeFile(absolute, content);
  }
  return root;
}

test("good CLI main exit mapping and root NotifyContext do not create high false positives", async () => {
  const root = await writeTree({
    "main.go": `package main

import (
	"os"
)

type rootCmd struct{}

func (rootCmd) ExitCode(err error) int { return 1 }
func (rootCmd) Execute() error { return nil }

func main() {
	cmd := rootCmd{}
	if err := cmd.Execute(); err != nil {
		os.Exit(cmd.ExitCode(err))
	}
}
`,
    "cmd/root.go": `package cmd

import (
	"context"
	"os"
	"os/signal"
)

func Execute() error {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt)
	defer stop()
	return run(ctx)
}

func run(ctx context.Context) error {
	_ = ctx
	return nil
}
`,
  });

  const result = await createApp().run({ input: { source: { path: root } } });
  const exitFindings = result.findings.filter((f) => f.ruleId === "go-cli.exit-bypass");
  const cancelFindings = result.findings.filter((f) => f.ruleId === "go-cli.cancellation");
  assert.equal(exitFindings.length, 0, "main os.Exit(ExitCode) must not be flagged");
  assert.equal(
    cancelFindings.length,
    0,
    "signal.NotifyContext(context.Background()) must not be flagged",
  );
});

test("defer os.Exit and handler Background still fire; scripts are ignored", async () => {
  const root = await writeTree({
    "cmd/create.go": `package cmd

import (
	"context"
	"os"
)

func run() {
	defer os.Exit(124)
	_ = context.Background()
}
`,
    "scripts/verify.go": `package main

import (
	"context"
	"os"
	"os/exec"
)

func main() {
	os.Exit(1)
	_ = context.Background()
	_ = exec.Command("go", "test")
}
`,
  });

  const result = await createApp().run({ input: { source: { path: root } } });
  const exit = result.findings.find((f) => f.ruleId === "go-cli.exit-bypass");
  const cancel = result.findings.find((f) => f.ruleId === "go-cli.cancellation");
  assert.ok(exit, "defer os.Exit must still fire");
  assert.ok(
    exit?.evidence.every((item) => !String(item.location?.file ?? "").includes("scripts/")),
    "scripts must not appear in exit evidence",
  );
  assert.ok(cancel, "handler context.Background must still fire");
  assert.ok(
    cancel?.evidence.every((item) => !String(item.location?.file ?? "").includes("scripts/")),
    "scripts must not appear in cancellation evidence",
  );
  assert.equal(
    result.findings.some((f) =>
      f.evidence.some((item) => String(item.location?.file ?? "").includes("scripts/")),
    ),
    false,
  );
});
