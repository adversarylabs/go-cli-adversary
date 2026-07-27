import assert from "node:assert/strict";
import { mkdtemp, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createApp } from "../src/index.ts";

test("promptui.ErrInterrupt alone is not interactive-no-tty", async () => {
  const root = await mkdtemp(join(tmpdir(), "go-cli-interrupt-"));
  await mkdir(join(root, "cli", "cmd"), { recursive: true });
  await writeFile(
    join(root, "cli", "cmd", "watch.go"),
    `package cmd

import (
	"errors"
	"github.com/manifoldco/promptui"
)

func watchLoop(err error) {
	if errors.Is(err, promptui.ErrInterrupt) {
		return
	}
}
`,
  );
  const output = await createApp().run({ input: { source: { path: root } }, includeRawObservations: true });
  assert.equal(
    output.findings.some((f) => f.ruleId === "go-cli.interactive-no-tty"),
    false,
    `unexpected findings: ${JSON.stringify(output.findings, null, 2)}`,
  );
});

test("main os.Exit(1) is not exit-bypass", async () => {
  const root = await mkdtemp(join(tmpdir(), "go-cli-main-exit-"));
  await writeFile(
    join(root, "main.go"),
    `package main
import "os"
func main() {
	if err := run(); err != nil {
		os.Exit(1)
	}
}
func run() error { return nil }
`,
  );
  const output = await createApp().run({ input: { source: { path: root } }, includeRawObservations: true });
  assert.equal(
    output.findings.some((f) => f.ruleId === "go-cli.exit-bypass"),
    false,
    `unexpected findings: ${JSON.stringify(output.findings, null, 2)}`,
  );
});
