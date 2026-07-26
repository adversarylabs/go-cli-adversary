import assert from "node:assert/strict";
import test from "node:test";
import { domain } from "../src/domain.ts";

test("wave D: init side effects fire for client construction in init", () => {
  const signals = domain.analyze({
    path: "pkg/client/client.go",
    current: `package client
import "net/http"
func init() {
	_ = &http.Client{}
}
`,
    changedLines: new Set(),
    status: "repository",
  }).signals;
  assert.ok(signals.some((s) => s.ruleId === "go-cli.init-side-effects"));
});

test("wave D: os.Args outside main fires", () => {
  const signals = domain.analyze({
    path: "cmd/root.go",
    current: `package cmd
import "os"
func parse() { _ = os.Args[1:] }
`,
    changedLines: new Set(),
    status: "repository",
  }).signals;
  assert.ok(signals.some((s) => s.ruleId === "go-cli.os-args-outside-main"));
});

test("wave D: os.Args in main.go does not fire", () => {
  const signals = domain.analyze({
    path: "main.go",
    current: `package main
import "os"
func main() { _ = os.Args }
`,
    changedLines: new Set(),
    status: "repository",
  }).signals;
  assert.equal(signals.filter((s) => s.ruleId === "go-cli.os-args-outside-main").length, 0);
});

test("wave D: ansi spinner without TTY guard", () => {
  const signals = domain.analyze({
    path: "cmd/ui.go",
    current: `package cmd
import "github.com/briandowns/spinner"
func spin() { _ = spinner.New(spinner.CharSets[14], 100) }
`,
    changedLines: new Set(),
    status: "repository",
  }).signals;
  assert.ok(signals.some((s) => s.ruleId === "go-cli.ansi-no-tty"));
});

test("wave D: option smuggling risk on git with variable ref", () => {
  const signals = domain.analyze({
    path: "cmd/git.go",
    current: `package cmd
import "os/exec"
func show(ref string) {
	_ = exec.Command("git", "checkout", ref)
}
`,
    changedLines: new Set(),
    status: "repository",
  }).signals;
  assert.ok(signals.some((s) => s.ruleId === "go-cli.option-smuggling-risk"));
});
