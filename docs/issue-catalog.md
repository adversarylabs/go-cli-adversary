# go/cli — issue catalog

This document is the **issue catalog** for this adversary: the classes of defects we aim to find, how we detect them (static vs LLM), public pattern references, and staff priority (P0 / P1 / LLM-only / Cut).

It is documentation and roadmap for contributors — not a runtime contract. Implemented detectors live in `src/` with fixtures under `fixtures/`; the **Review verdicts** section records what ships first.

Public examples cited below illustrate bad patterns only. Do not scrape secrets from them or copy copyrighted code into fixtures.

**Catalog id:** `go/cli`  
**Status:** public OSS documentation of the issue classes this adversary targets  
**Goal:** trusted, high-precision detections. Prefer missing a weak signal over a false positive.

## Mission
World-class Go CLIs: correct exits, cancellation, safe flags, predictable UX, and no foot-guns.

## LLM strategy (required for world-class)
**Enhance:** UX and safety narrative across cobra command trees.
**Discover:** destructive ops without guards; insecure self-update.

### Division of labor
Static = precise facts. LLM = enhancement + evidence-gated discovery. When unsure, omit.

## Review verdicts (staff pass)

- **P0 implement:** `context.missing`, `exit.codes`, `flags.password-argv`, `errors.silent`, `update.insecure`
- **P1:** `flags.required-silent`, `stdout.secrets`, `errors.unwrapped`, `path.user-expand`, `concurrency.unbounded`, `version.missing`, `color.no-tty`, `migrate.destructive`, `plugin.exec`, `logging.level-default-debug`, `fs.cwd-assume`, `timeout.missing`, `profiling.pprof-flag`, `creds.world-readable`
- **LLM-only:** `stdin.partial`, `network.default-on`, `dry-run.missing`
- **Cut:** `help.incomplete` — pure style, unreliable detection. `config.precedence` — unverifiable opinion. `shell.completion-stale` — rare and not reliably detectable.

## Issue catalog

---
### 1. `go-cli.exit.codes` — os.Exit with wrong codes / deferred skip

| Field | Value |
| --- | --- |
| **Severity** | medium |
| **Target confidence** | high |

**What it is.** os.Exit skips defers; always 0 on errors.

**Static detection.** Detect os.Exit in main helpers; missing non-zero on err; log.Fatal* outside package main (kills the process, skips defers, untestable).

**LLM role.** Recommend error return from main pattern.

**False-positive guards.** Truly fatal abort after flush.

**Public examples of the bad pattern:**
  - https://github.com/golang/go/wiki/CodeReviewComments
  - https://pkg.go.dev/os#Exit
  - https://github.com/spf13/cobra

---
### 2. `go-cli.context.missing` — Root command without signal context

| Field | Value |
| --- | --- |
| **Severity** | high |
| **Target confidence** | high |

**What it is.** CLI long ops ignore SIGINT.

**Static detection.** Detect main without signal.NotifyContext.

**LLM role.** Wire ctx to subcommands.

**False-positive guards.** Instant commands.

**Public examples of the bad pattern:**
  - https://pkg.go.dev/os/signal#NotifyContext
  - https://github.com/spf13/cobra
  - https://github.com/urfave/cli

---
### 3. `go-cli.flags.required-silent` — Required flags not validated

| Field | Value |
| --- | --- |
| **Severity** | medium |
| **Target confidence** | medium |

**What it is.** Empty string flags used without check.

**Static detection.** Detect flag vars used without validation.

**LLM role.** Cobra MarkFlagRequired patterns.

**False-positive guards.** Optional flags; MarkFlagRequired already enforced by the framework. Expect real FP pressure here — ship behind LLM confirmation.

**Public examples of the bad pattern:**
  - https://github.com/spf13/cobra
  - https://github.com/spf13/pflag
  - https://pkg.go.dev/flag

---
### 4. `go-cli.flags.password-argv` — Secrets via argv flags

| Field | Value |
| --- | --- |
| **Severity** | high |
| **Target confidence** | high |

**What it is.** password flag visible in ps.

**Static detection.** Detect password/token flags.

**LLM role.** Recommend env/file/prompt.

**False-positive guards.** Non-secret tokens.

**Public examples of the bad pattern:**
  - https://github.com/spf13/cobra
  - https://github.com/OWASP/wrongsecrets
  - https://pkg.go.dev/syscall

---
### 5. `go-cli.stdout.secrets` — Printing secrets to stdout

| Field | Value |
| --- | --- |
| **Severity** | high |
| **Target confidence** | medium |

**What it is.** fmt.Println(token).

**Static detection.** Detect print of secret-like vars.

**LLM role.** LLM.

**False-positive guards.** Intentionally issuing tokens.

**Public examples of the bad pattern:**
  - https://github.com/OWASP/Go-SCP
  - https://github.com/spf13/cobra
  - https://go.dev/blog/slog

---
### 6. `go-cli.errors.unwrapped` — fmt.Errorf without %w

| Field | Value |
| --- | --- |
| **Severity** | low |
| **Target confidence** | high |

**What it is.** Breaks errors.Is/As.

**Static detection.** Detect Errorf without %w when wrapping err.

**LLM role.** Style+correctness.

**False-positive guards.** Intentional new errors.

**Public examples of the bad pattern:**
  - https://go.dev/blog/go1.13-errors
  - https://pkg.go.dev/errors
  - https://github.com/golang/go/wiki/CodeReviewComments

---
### 7. `go-cli.errors.silent` — Ignoring errors from critical calls

| Field | Value |
| --- | --- |
| **Severity** | high |
| **Target confidence** | high |

**What it is.** _ = os.WriteFile(...).

**Static detection.** Detect blank ident on error results in cmd paths.

**LLM role.** LLM importance.

**False-positive guards.** Best-effort optional ops.

**Public examples of the bad pattern:**
  - https://github.com/golang/go/wiki/CodeReviewComments
  - https://pkg.go.dev/os
  - https://github.com/securego/gosec

---
### 8. `go-cli.path.user-expand` — User paths without clean/abs

| Field | Value |
| --- | --- |
| **Severity** | medium |
| **Target confidence** | medium |

**What it is.** Open user --file without validation.

**Static detection.** Detect Open(flag).

**LLM role.** Traversal risk.

**False-positive guards.** Trusted operators only tools.

**Public examples of the bad pattern:**
  - https://pkg.go.dev/path/filepath
  - https://github.com/securego/gosec — G304
  - https://go.dev/blog/osroot

---
### 9. `go-cli.concurrency.unbounded` — Worker pool unbounded from CLI args

| Field | Value |
| --- | --- |
| **Severity** | medium |
| **Target confidence** | medium |

**What it is.** --jobs 100000.

**Static detection.** Detect GOMAXPROCS/jobs flags without caps.

**LLM role.** Suggest max.

**False-positive guards.** Power user tools with warnings.

**Public examples of the bad pattern:**
  - https://pkg.go.dev/golang.org/x/sync/errgroup
  - https://github.com/sourcegraph/conc
  - https://github.com/spf13/cobra

---
### 10. `go-cli.version.missing` — No version/commit stamp

| Field | Value |
| --- | --- |
| **Severity** | low |
| **Target confidence** | high |

**What it is.** Hard to support users.

**Static detection.** Detect missing version var ldflags.

**LLM role.** Recommend -X pattern.

**False-positive guards.** Tiny scripts.

**Public examples of the bad pattern:**
  - https://github.com/spf13/cobra
  - https://github.com/adversarylabs/adversary — version package
  - https://pkg.go.dev/runtime/debug#ReadBuildInfo

---
### 11. `go-cli.color.no-tty` — ANSI colors when not a TTY

| Field | Value |
| --- | --- |
| **Severity** | low |
| **Target confidence** | medium |

**What it is.** Breaks pipes.

**Static detection.** Detect color libs without isatty.

**LLM role.** Suggest term detection.

**False-positive guards.** Forced --color always; fatih/color and most modern libs already auto-disable on non-TTY and honor NO_COLOR — only flag raw ANSI escape literals emitted without an isatty/NO_COLOR check.

**Public examples of the bad pattern:**
  - https://github.com/fatih/color
  - https://github.com/mattn/go-isatty
  - https://github.com/spf13/cobra

---
### 12. `go-cli.stdin.partial` — Not handling non-TTY stdin EOF

| Field | Value |
| --- | --- |
| **Severity** | medium |
| **Target confidence** | medium |

**What it is.** Hangs waiting for input.

**Static detection.** Detect fmt.Scan without EOF handling.

**LLM role.** LLM-only — static signal too weak; require evidence of an interactive prompt with no TTY check.

**False-positive guards.** Interactive only.

**Public examples of the bad pattern:**
  - https://pkg.go.dev/bufio
  - https://github.com/spf13/cobra
  - https://pkg.go.dev/os

---
### 13. `go-cli.migrate.destructive` — Destructive CLI without confirm

| Field | Value |
| --- | --- |
| **Severity** | high |
| **Target confidence** | medium |

**What it is.** delete/drop commands without --yes.

**Static detection.** Detect dangerous command names without confirm flag.

**LLM role.** Require double-// confirmation.

**False-positive guards.** Dry-run default.

**Public examples of the bad pattern:**
  - https://github.com/spf13/cobra
  - https://github.com/golang-migrate/migrate
  - https://github.com/cli/cli

---
### 14. `go-cli.network.default-on` — Network access default without opt-in

| Field | Value |
| --- | --- |
| **Severity** | medium |
| **Target confidence** | low |

**What it is.** Phone-home default.

**Static detection.** LLM + http client in init.

**LLM role.** Privacy.

**False-positive guards.** Package managers need network.

**Public examples of the bad pattern:**
  - https://github.com/cli/cli
  - https://github.com/spf13/cobra
  - https://pkg.go.dev/net/http

---
### 15. `go-cli.plugin.exec` — Plugin path exec without verification

| Field | Value |
| --- | --- |
| **Severity** | high |
| **Target confidence** | medium |

**What it is.** Lookpath user plugins.

**Static detection.** Detect exec of plugin paths.

**LLM role.** Checksum trust.

**False-positive guards.** Explicit trusted dirs.

**Public examples of the bad pattern:**
  - https://github.com/cli/cli — plugin model
  - https://pkg.go.dev/os/exec
  - https://github.com/spf13/cobra

---
### 16. `go-cli.update.insecure` — Self-update over HTTP / no checksum

| Field | Value |
| --- | --- |
| **Severity** | high |
| **Target confidence** | medium |

**What it is.** Insecure updater.

**Static detection.** Detect download+exec update paths.

**LLM role.** Require sigs/checksums.

**False-positive guards.** None.

**Public examples of the bad pattern:**
  - https://github.com/creativeprojects/go-selfupdate
  - https://github.com/inconshreveable/go-update
  - https://github.com/cli/cli

---
### 17. `go-cli.logging.level-default-debug` — Default log level debug

| Field | Value |
| --- | --- |
| **Severity** | low |
| **Target confidence** | high |

**What it is.** Noisy/secrets risk.

**Static detection.** Detect default debug loggers.

**LLM role.** Info default.

**False-positive guards.** Dev builds.

**Public examples of the bad pattern:**
  - https://go.dev/blog/slog
  - https://github.com/spf13/cobra
  - https://github.com/rs/zerolog

---
### 18. `go-cli.fs.cwd-assume` — Assumes process cwd is repo root

| Field | Value |
| --- | --- |
| **Severity** | medium |
| **Target confidence** | medium |

**What it is.** Fragile relative paths.

**Static detection.** Detect Open("go.mod") without walk-up.

**LLM role.** Find repo root helpers.

**False-positive guards.** Documented cwd requirements.

**Public examples of the bad pattern:**
  - https://github.com/spf13/cobra
  - https://github.com/go-git/go-git
  - https://pkg.go.dev/os#Getwd

---
### 19. `go-cli.timeout.missing` — Long network ops without timeout flags

| Field | Value |
| --- | --- |
| **Severity** | medium |
| **Target confidence** | medium |

**What it is.** Hung CLIs.

**Static detection.** Detect http clients in CLI without --timeout.

**LLM role.** Expose flag + ctx.

**False-positive guards.** Local-only tools.

**Public examples of the bad pattern:**
  - https://blog.cloudflare.com/the-complete-guide-to-golang-net-http-timeouts/
  - https://github.com/spf13/cobra
  - https://pkg.go.dev/context

---
### 20. `go-cli.dry-run.missing` — Mutating remote ops without dry-run

| Field | Value |
| --- | --- |
| **Severity** | medium |
| **Target confidence** | low |

**What it is.** Ops safety.

**Static detection.** Detect apply/delete without dry-run.

**LLM role.** Suggest flag.

**False-positive guards.** Read-only tools.

**Public examples of the bad pattern:**
  - https://github.com/kubernetes/kubectl — dry-run patterns
  - https://github.com/cli/cli
  - https://github.com/spf13/cobra

---
### 21. `go-cli.profiling.pprof-flag` — Hidden pprof server default on

| Field | Value |
| --- | --- |
| **Severity** | medium |
| **Target confidence** | medium |

**What it is.** Accidental exposure.

**Static detection.** Detect pprof listen without flag default false.

**LLM role.** Off by default.

**False-positive guards.** Explicit debug builds.

**Public examples of the bad pattern:**
  - https://pkg.go.dev/net/http/pprof
  - https://github.com/spf13/cobra
  - https://github.com/securego/gosec

---
### 22. `go-cli.creds.world-readable` — Credential files written with permissive modes

| Field | Value |
| --- | --- |
| **Severity** | medium |
| **Target confidence** | high |

**What it is.** os.WriteFile(tokenPath, ..., 0644) leaves tokens readable by other local users — the kubeconfig-permissions class of bug.

**Static detection.** WriteFile/OpenFile/Chmod with perm > 0600 where the path or content is credential-like (token, credentials, .netrc, auth config).

**LLM role.** Is the content actually secret vs public config/cache?

**False-positive guards.** Non-secret config and cache files; explicit umask handling.

**Public examples of the bad pattern:**
  - https://github.com/securego/gosec — G306
  - https://pkg.go.dev/os#WriteFile
  - https://kubernetes.io/docs/concepts/configuration/organize-cluster-access-kubeconfig/ — kubectl warns on world-readable kubeconfig

---

## Implementation roadmap (after approval)
P0 static rules + fixtures → LLM enhancement → discovery → precision bake-off on public repos.

**P0 priorities:** signal context, os.Exit/log.Fatal vs defers, secrets on argv, ignored errors, insecure self-update.
