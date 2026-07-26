import assert from "node:assert/strict";
import test from "node:test";
import { domain } from "../src/domain.ts";

test("wave C: cobra without SilenceUsage fires; with SilenceUsage does not", () => {
  const bad = domain.analyze({
    path: "cmd/root.go",
    current: `package cmd
import "github.com/spf13/cobra"
func New() *cobra.Command {
	return &cobra.Command{Use: "tool", RunE: func(cmd *cobra.Command, args []string) error { return nil }}
}
`,
    changedLines: new Set(),
    status: "repository",
  }).signals;
  assert.ok(bad.some((s) => s.ruleId === "go-cli.cobra-silence-usage"));

  const good = domain.analyze({
    path: "cmd/root.go",
    current: `package cmd
import "github.com/spf13/cobra"
func New() *cobra.Command {
	return &cobra.Command{Use: "tool", SilenceUsage: true}
}
`,
    changedLines: new Set(),
    status: "repository",
  }).signals;
  assert.equal(good.filter((s) => s.ruleId === "go-cli.cobra-silence-usage").length, 0);
});

test("wave C: version identity missing on cobra root", () => {
  const signals = domain.analyze({
    path: "cmd/root.go",
    current: `package cmd
import "github.com/spf13/cobra"
func NewRoot() *cobra.Command {
	return &cobra.Command{Use: "app", SilenceUsage: true}
}
`,
    changedLines: new Set(),
    status: "repository",
  }).signals;
  assert.ok(signals.some((s) => s.ruleId === "go-cli.version-identity"));
});

test("wave C: version identity not flagged when Version set", () => {
  const signals = domain.analyze({
    path: "cmd/root.go",
    current: `package cmd
import "github.com/spf13/cobra"
func NewRoot() *cobra.Command {
	return &cobra.Command{Use: "app", Version: "1.0.0", SilenceUsage: true}
}
`,
    changedLines: new Set(),
    status: "repository",
  }).signals;
  assert.equal(signals.filter((s) => s.ruleId === "go-cli.version-identity").length, 0);
});

test("wave C: JSON to stdout without format flag", () => {
  const signals = domain.analyze({
    path: "cmd/list.go",
    current: `package cmd
import (
	"encoding/json"
	"os"
)
func list() {
	_ = json.NewEncoder(os.Stdout).Encode(map[string]string{"ok": "1"})
}
`,
    changedLines: new Set(),
    status: "repository",
  }).signals;
  assert.ok(signals.some((s) => s.ruleId === "go-cli.json-without-format"));
});

test("wave C: bare log.Print for CLI UX", () => {
  const signals = domain.analyze({
    path: "cmd/msg.go",
    current: `package cmd
import "log"
func hi() { log.Println("hello user") }
`,
    changedLines: new Set(),
    status: "repository",
  }).signals;
  assert.ok(signals.some((s) => s.ruleId === "go-cli.bare-user-log"));
});
