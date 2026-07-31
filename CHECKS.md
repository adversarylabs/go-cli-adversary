# Checks — what go/cli detects

This file is the **public audit list** of detectors. If a rule id appears here, it is part of the product surface: it should fire on a vulnerable pattern, stay quiet on the documented clean case, and produce file:line evidence where applicable.

Runtime source of truth: [`src/domain.ts`](src/domain.ts).
Regression entry: fixture and corpus tests under `test/`.

**Scope:** non-test `*.go` files in CLI-oriented packages.

---

## High

### `go-cli.exit-bypass`

| | |
| --- | --- |
| **What** | Command code terminates the process directly |
| **Why** | Skips deferred cleanup and prevents callers/tests from handling failure |
| **Looks for** | `os.Exit`, `log.Fatal*`, logger Fatals below main |
| **Stays quiet when** | Exit only at the application boundary in `main` |
| **Remediation** | Return errors from commands; map once to exit codes in main |

### `go-cli.execute-error`

| | |
| --- | --- |
| **What** | Root command error is discarded |
| **Why** | Automation sees success when the command failed |
| **Looks for** | Cobra/Kong/urfave `Execute`/`Run` without checking error |
| **Stays quiet when** | Error handled at main with non-zero exit |
| **Remediation** | Handle the returned error; print one stable diagnostic; exit non-zero |

### `go-cli.shell-interpolation`

| | |
| --- | --- |
| **What** | Shell used to interpolate a command string |
| **Why** | Path/argument data becomes executable shell syntax |
| **Looks for** | `exec.Command("sh"|"bash", "-c", …)` with composed strings |
| **Stays quiet when** | Argv form without a shell |
| **Remediation** | Prefer argv slices; never shell untrusted input |

### `go-cli.flags-password-argv`

| | |
| --- | --- |
| **What** | Password/token-like secrets on CLI argv |
| **Why** | Visible via `ps`, audit logs, crash dumps |
| **Looks for** | `--password` / `--token` / `--secret` style flags |
| **Stays quiet when** | Secrets via env, files, or interactive secret prompts |
| **Remediation** | Do not put secrets on argv |

### `go-cli.broad-process-kill`

| | |
| --- | --- |
| **What** | Process cleanup uses a broad pattern kill |
| **Why** | Can terminate unrelated processes |
| **Looks for** | Broad `pkill`/`killall` patterns in cleanup |
| **Stays quiet when** | Targeted PID kill of owned children |
| **Remediation** | Track PIDs and kill only children you started |

## Medium

### `go-cli.cancellation`

| | |
| --- | --- |
| **What** | Long-running work starts from non-cancellable context |
| **Why** | Ctrl-C / orchestration cancel does not stop work |
| **Looks for** | `context.Background` / `TODO` in command paths |
| **Stays quiet when** | Uses `cmd.Context()` or framework context |
| **Remediation** | Pass the command context through long-running ops |

### `go-cli.subprocess-no-context`

| | |
| --- | --- |
| **What** | Subprocess without CommandContext |
| **Why** | Children survive CLI cancel |
| **Looks for** | `exec.Command` without parent context |
| **Stays quiet when** | `exec.CommandContext` with command context |
| **Remediation** | Always bind children to the command context |

### `go-cli.subprocess-stderr-discarded`

| | |
| --- | --- |
| **What** | Stdout captured while stderr discarded |
| **Why** | Failures hard to diagnose |
| **Looks for** | `cmd.Output()` without capturing stderr |
| **Stays quiet when** | `CombinedOutput` or attach stderr |
| **Remediation** | Surface child stderr in errors |

### `go-cli.exit-code-convention`

| | |
| --- | --- |
| **What** | Exit code 2 used as catch-all runtime failure |
| **Why** | Code 2 is conventionally usage/validation |
| **Looks for** | Helpers mapping all errors to 2 |
| **Stays quiet when** | Usage→2, runtime→1 (or documented domain codes) |
| **Remediation** | Reserve 2 for usage; use 1 for runtime |

### `go-cli.stdout-progress`

| | |
| --- | --- |
| **What** | Progress/diagnostics written to stdout |
| **Why** | Breaks JSON/pipe contracts |
| **Looks for** | Progress bars / logs on stdout |
| **Stays quiet when** | Progress on stderr; data on stdout |
| **Remediation** | Keep stdout machine-readable when piping |

### `go-cli.http-no-timeout`

| | |
| --- | --- |
| **What** | HTTP client has no timeout budget |
| **Why** | CLI hangs forever on dead peers |
| **Looks for** | `http.Client` without Timeout / no deadline |
| **Stays quiet when** | Explicit Timeout or context deadline |
| **Remediation** | Always set a client timeout |

### `go-cli.interactive-no-tty`

| | |
| --- | --- |
| **What** | Interactive input without non-TTY guard |
| **Why** | Automation blocks on stdin |
| **Looks for** | Prompts without TTY check |
| **Stays quiet when** | Guards for non-interactive mode |
| **Remediation** | Fail fast or use flags when not a TTY |

### `go-cli.option-smuggling-risk`

| | |
| --- | --- |
| **What** | Revision-like args passed to subprocess without validation |
| **Why** | Option smuggling / unexpected git behavior |
| **Looks for** | Unvalidated refs to git/subprocess |
| **Stays quiet when** | Validated refs or `--` separators |
| **Remediation** | Validate and separate options from operands |

### `go-cli.json-without-format`

| | |
| --- | --- |
| **What** | JSON on stdout without an obvious format switch |
| **Why** | Breaks human and machine dual use |
| **Looks for** | Always-on JSON without `--format`/`--json` |
| **Stays quiet when** | Explicit format flag |
| **Remediation** | Gate machine output behind a format flag |

## Low

### `go-cli.silence-usage`

| | |
| --- | --- |
| **What** | Cobra does not silence usage on runtime errors |
| **Why** | Noise on runtime failures |
| **Looks for** | Missing `SilenceUsage` |
| **Stays quiet when** | SilenceUsage for runtime errors |
| **Remediation** | Set `SilenceUsage: true` on root/commands |

### `go-cli.version-identity`

| | |
| --- | --- |
| **What** | CLI root lacks inspectable version identity |
| **Why** | Support and regression hard |
| **Looks for** | No version flag/command |
| **Stays quiet when** | Version from build info |
| **Remediation** | Expose version via flag or subcommand |

### `go-cli.bare-user-log`

| | |
| --- | --- |
| **What** | Bare log package for user messaging |
| **Why** | Timestamps/noise on CLI UX |
| **Looks for** | `log.Print*` for user-facing messages |
| **Stays quiet when** | fmt to stderr or structured CLI logger |
| **Remediation** | Use intentional user messaging APIs |

### `go-cli.init-side-effects`

| | |
| --- | --- |
| **What** | Package init performs I/O or client construction |
| **Why** | Import-time side effects |
| **Looks for** | `init()` with network/fs/client setup |
| **Stays quiet when** | Lazy construction in main/command |
| **Remediation** | Keep init pure |

### `go-cli.os-args-outside-main`

| | |
| --- | --- |
| **What** | Library/command package reads os.Args directly |
| **Why** | Hard to test; fights frameworks |
| **Looks for** | `os.Args` outside main |
| **Stays quiet when** | Args via framework / parameters |
| **Remediation** | Accept args as parameters |

### `go-cli.ansi-no-tty`

| | |
| --- | --- |
| **What** | ANSI/spinner without terminal guard |
| **Why** | Garbles CI logs |
| **Looks for** | Color/spinner without TTY check |
| **Stays quiet when** | Disable when not a TTY |
| **Remediation** | Guard ANSI output |
