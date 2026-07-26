import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ModelUnavailableError } from "@adversarylabs/sdk";
import { createApp } from "../src/index.ts";
import { domain } from "../src/domain.ts";

async function writeTree(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "go-cli-wave-a-"));
  for (const [relative, content] of Object.entries(files)) {
    const absolute = join(root, relative);
    await mkdir(join(absolute, ".."), { recursive: true });
    await writeFile(absolute, content);
  }
  return root;
}

async function review(root: string) {
  return createApp().run({
    model: {
      async review() {
        throw new ModelUnavailableError();
      },
    },
    input: { source: { path: root } },
  });
}

function ruleIds(result: Awaited<ReturnType<typeof review>>): string[] {
  return result.findings.map((f) => f.ruleId ?? "").filter(Boolean).sort();
}

test("wave A: exit-code convention flags return 2 in ExitCode helpers", () => {
  const signals = domain.analyze({
    path: "cmd/exit.go",
    current: `package cmd

func ExitCode(err error) int {
	if err == nil {
		return 0
	}
	return 2
}
`,
    changedLines: new Set(),
    status: "repository",
  }).signals;
  assert.ok(signals.some((s) => s.ruleId === "go-cli.exit-code-convention"));
});

test("wave A: subprocess Output() flags stderr discard", () => {
  const signals = domain.analyze({
    path: "cmd/run.go",
    current: `package cmd
import "os/exec"
func run() {
	out, _ := exec.Command("git", "status").Output()
	_ = out
}
`,
    changedLines: new Set(),
    status: "repository",
  }).signals;
  assert.ok(signals.some((s) => s.ruleId === "go-cli.subprocess-stderr-discarded"));
});

test("wave A: stdout progress and interactive without TTY", () => {
  const signals = domain.analyze({
    path: "cmd/ui.go",
    current: `package cmd
import (
	"bufio"
	"fmt"
	"os"
)
func confirm() {
	fmt.Fprintln(os.Stdout, "Downloading package…")
	sc := bufio.NewScanner(os.Stdin)
	_ = sc
}
`,
    changedLines: new Set(),
    status: "repository",
  }).signals;
  assert.ok(signals.some((s) => s.ruleId === "go-cli.stdout-progress"));
  assert.ok(signals.some((s) => s.ruleId === "go-cli.interactive-no-tty"));
});

test("wave A: interactive with IsTerminal does not fire", () => {
  const signals = domain.analyze({
    path: "cmd/ui.go",
    current: `package cmd
import (
	"bufio"
	"os"
	"golang.org/x/term"
)
func confirm() {
	if !term.IsTerminal(int(os.Stdin.Fd())) {
		return
	}
	sc := bufio.NewScanner(os.Stdin)
	_ = sc
}
`,
    changedLines: new Set(),
    status: "repository",
  }).signals;
  assert.equal(
    signals.filter((s) => s.ruleId === "go-cli.interactive-no-tty").length,
    0,
  );
});

test("wave A: http.Client without Timeout fires; with Timeout does not", () => {
  const bad = domain.analyze({
    path: "cmd/http.go",
    current: `package cmd
import "net/http"
func client() *http.Client { return &http.Client{} }
`,
    changedLines: new Set(),
    status: "repository",
  }).signals;
  assert.ok(bad.some((s) => s.ruleId === "go-cli.http-no-timeout"));

  const good = domain.analyze({
    path: "cmd/http.go",
    current: `package cmd
import (
	"net/http"
	"time"
)
func client() *http.Client {
	return &http.Client{Timeout: 30 * time.Second}
}
`,
    changedLines: new Set(),
    status: "repository",
  }).signals;
  assert.equal(good.filter((s) => s.ruleId === "go-cli.http-no-timeout").length, 0);
});

test("wave A: nested Transport + Timeout does not false-positive http-no-timeout", () => {
  // Would fail with a naive /http.Client{([^}]*)}/ parse that stops at Transport's '}'.
  const signals = domain.analyze({
    path: "cmd/http.go",
    current: `package cmd
import (
	"net/http"
	"time"
)
func client(transport http.RoundTripper) *http.Client {
	return &http.Client{
		Transport: &http.Transport{
			Proxy: http.ProxyFromEnvironment,
			MaxIdleConns: 100,
		},
		Timeout: 30 * time.Second,
	}
}
`,
    changedLines: new Set(),
    status: "repository",
  }).signals;
  assert.equal(
    signals.filter((s) => s.ruleId === "go-cli.http-no-timeout").length,
    0,
    "Timeout after nested Transport must be recognized",
  );
});

test("wave A: nested Transport without Timeout still fires", () => {
  const signals = domain.analyze({
    path: "cmd/http.go",
    current: `package cmd
import "net/http"
func client(transport http.RoundTripper) *http.Client {
	return &http.Client{
		Transport: &http.Transport{Proxy: http.ProxyFromEnvironment},
	}
}
`,
    changedLines: new Set(),
    status: "repository",
  }).signals;
  assert.ok(signals.some((s) => s.ruleId === "go-cli.http-no-timeout"));
});

test("wave A: end-to-end review surfaces new rules without exit-bypass on main ExitCode", async () => {
  const root = await writeTree({
    "main.go": `package main
import "os"
type cmd struct{}
func (cmd) ExitCode(err error) int {
	if err == nil { return 0 }
	return 2
}
func (cmd) Execute() error { return nil }
func main() {
	c := cmd{}
	if err := c.Execute(); err != nil {
		os.Exit(c.ExitCode(err))
	}
}
`,
    "cmd/net.go": `package cmd
import (
	"fmt"
	"net/http"
	"os"
	"os/exec"
)
func run() {
	_ = &http.Client{}
	out, _ := exec.Command("git", "status").Output()
	_ = out
	fmt.Fprintln(os.Stdout, "Downloading…")
}
`,
  });
  const result = await review(root);
  const ids = ruleIds(result);
  assert.ok(ids.includes("go-cli.http-no-timeout") || ids.includes("go-cli.subprocess-stderr-discarded") || ids.includes("go-cli.stdout-progress") || ids.includes("go-cli.exit-code-convention"), `expected wave A finding, got ${ids.join(",")}`);
  // Dogfood anchors
  const exit = result.findings.find((f) => f.ruleId === "go-cli.exit-bypass");
  assert.equal(exit, undefined, "must not flag process-boundary ExitCode in main");
});
