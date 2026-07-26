# Go CLI top-50 patterns — triage list

Triage backlog for **go-cli**: patterns a static analyzer and/or model review can look for.
Derived from the “top 20 things a Go CLI should do” checklist, dogfood on `adversary` /
`replicated`, and common production CLI failures.

## How to use this table

| Column | Meaning |
| --- | --- |
| **#** | Priority order for product impact (rough; re-rank as we learn) |
| **Pattern** | What to detect or judge |
| **Why it matters** | User / automation impact |
| **Static** | Deterministic rules (AST, regex, structure) — `none` / `easy` / `medium` / `hard` |
| **LLM** | Model review (structured schema, titles → noun-phrase concerns) — `none` / `good` / `best` |
| **Coverage** | `done` / `partial` / `planned` / `later` / `out` |
| **Rule / note** | Existing rule id or triage decision |

### Severity guide (when we implement)

| Class | Typical severity |
| --- | --- |
| Lifecycle / process trust / injection | medium–high |
| Stream / JSON / exit contracts | medium–high |
| Flags / config / interactive | medium |
| Completions / polish / docs | low or observation only |
| Secrets / generic Go style | out of scope (other adversaries) |

### Detection split (default)

- **Static** owns: high-confidence, repeated, citable snippets (`os.Exit`, `exec.Command`, `context.Background` in handlers, shell `-c`).
- **LLM** owns: cross-file contracts, silent success, flag/schema mismatch, “would a scripter be surprised?”, deprecation semantics.
- **Both** when static finds a site and model explains user impact / whether it’s intentional.

---

## Triage table (top 50)

| # | Pattern | Why it matters | Static | LLM | Coverage | Rule / note |
| ---: | --- | --- | --- | --- | --- | --- |
| 1 | Process-boundary only exit (`os.Exit` / `log.Fatal*` not in `main`) | Cleanup, tests, error mapping skipped | easy | good | **done** | `go-cli.exit-bypass` + taste (`ExitCode` in `main` OK) |
| 2 | Root `Execute` / `Run` error discarded | Exit 0 on failure | easy | good | **done** | `go-cli.execute-error` |
| 3 | `defer os.Exit(N)` / forced exit codes in handlers | Always-N exit; breaks success path | easy | **best** | **done** | Static hit; model explains “always 124” semantics |
| 4 | Handler uses `context.Background` / `TODO` instead of `cmd.Context()` | Ctrl+C won’t cancel work | easy | good | **done** | `go-cli.cancellation` (skip root `NotifyContext`) |
| 5 | `exec.Command` without `CommandContext` | Orphan children on cancel/timeout | easy | good | **done** | `go-cli.subprocess-no-context` |
| 6 | Shell `sh -c` / `bash -c` with composed strings | Injection / arg smuggling | easy | good | **done** | `go-cli.shell-interpolation` |
| 7 | Validation after side effects (network/write before flag checks) | Partial work on bad input | hard | **best** | **done** | Model prompt: validation-order category |
| 8 | Progress / logs on stdout mixed with machine payload | Breaks pipes (`jq`, scripts) | medium | **best** | **done** | `go-cli.stdout-progress` (+ model for mixed JSON) |
| 9 | JSON and human text on same stream without mode switch | Silent parse failures | medium | **best** | **done** | Model json-contract + static stdout-progress |
| 10 | Interactive prompt without TTY / non-interactive guard | Hang or fail in CI | medium | **best** | **done** | `go-cli.interactive-no-tty` |
| 11 | Destructive command without `--yes` / `--force` / dry-run | Accidental data loss | medium | **best** | partial | Model dry-run / interactive categories |
| 12 | `--dry-run` overridden by other flags silently | User thinks apply ran | hard | **best** | **done** | Model dry-run category + prompt priority |
| 13 | Exit code 2 used as catch-all runtime failure | Conflicts with usage-error convention | medium | good | **done** | `go-cli.exit-code-convention` |
| 14 | Undocumented / unstable domain exit codes | Automation can’t branch | hard | good | later | Needs docs + code agreement |
| 15 | Inconsistent JSON envelope across commands | Scripts break by subcommand | hard | **best** | **done** | Model json-contract category |
| 16 | JSON schema not versioned (`schemaVersion` missing) | Breaking changes invisible | medium | good | **done** | Model json-contract priority |
| 17 | Deprecated flag emits different schema than replacement | Silent migration landmine | hard | **best** | **done** | Model deprecation category |
| 18 | Flag rename without alias / deprecation window | Hard breaks for users | medium | good | later | Flag definitions over time (diff-aware) |
| 19 | Required / mutually exclusive flags not validated | Runtime fail after work starts | medium | good | later | Needs structure-aware Cobra marks |
| 20 | Config precedence unclear or re-parsed ad hoc | “Why did env win?” | hard | **best** | later | Viper/bind patterns |
| 21 | Env vars without documented prefix | Collisions, surprise config | medium | good | later | `os.Getenv` / `AutomaticEnv` |
| 22 | Effective config not printable in debug/verbose | Un-debuggable prod issues | hard | good | later | Soft; observation |
| 23 | Version / build identity missing or always `dev` | Support and provenance fail | easy | good | **done** | `go-cli.version-identity` |
| 24 | Completions missing for public commands | Discoverability | medium | none | later | Soft / low ROI static |
| 25 | Help/examples drift from real flags | Users copy-paste wrong | hard | good | later | Golden help tests / model vs flags |
| 26 | Usage dumped on every runtime error | Noise; hides real error | medium | good | **done** | `go-cli.cobra-silence-usage` |
| 27 | Errors lack action (“what to try”) | Support load | hard | **best** | later | Model judgment on error strings |
| 28 | Usage errors not distinguished from runtime errors | Wrong exit code / help spam | medium | good | **done** | `go-cli.cobra-silence-usage` (+ exit codes) |
| 29 | Bare `log.Printf` / `fmt.Println` for CLI UX | Uncontrolled streams | medium | good | **done** | `go-cli.bare-user-log` |
| 30 | Secrets logged or printed in verbose mode | Credential leak | medium | good | **out** | Prefer secrets adversary; maybe light redaction check later |
| 31 | Credential files without restrictive permissions | Local secret theft | medium | none | **out** | Secrets / OS adversary |
| 32 | Network without timeout / budget | Hung CLI | medium | good | **done** | `go-cli.http-no-timeout` |
| 33 | Long operations without progress on stderr | Looks wedged | hard | good | later | Soft UX |
| 34 | Spinners / cursor control when not a TTY | Corrupts CI logs | medium | good | **done** | `go-cli.ansi-no-tty` |
| 35 | Subprocess stderr discarded | Undebuggable child failures | easy | good | **done** | `go-cli.subprocess-stderr-discarded` |
| 36 | Path args not cleaned / can escape root | Path traversal | medium | good | later | Needs path-boundary analysis |
| 37 | Git/docker args allow option smuggling (`-` prefixes) | Unexpected child behavior | medium | good | **done** | `go-cli.option-smuggling-risk` |
| 38 | Concurrent store access without lock | Corrupt local state | hard | good | later | File lock patterns |
| 39 | Mutating command not idempotent / leaves temp dirt | Partial failure pain | hard | **best** | later | Model on create/push flows |
| 40 | Success exit when primary action failed | Silent automation green | hard | **best** | **done** | Model prompt + exit static |
| 41 | `main` / `init` constructs global clients | Untestable, surprising side effects | medium | good | **done** | `go-cli.init-side-effects` |
| 42 | Commands not testable (`os.Args` only) | Regressions | hard | none | **done** | `go-cli.os-args-outside-main` |
| 43 | No composition root / deps injected | Unmaintainable monorepo CLI | hard | good | later | Observation / architecture |
| 44 | Signal handling only on Unix assumptions | Windows/CI weirdness | medium | none | later | Build tags / signal files |
| 45 | `filepath` vs URL `path` confusion | Cross-platform bugs | medium | good | later | Import misuse heuristics |
| 46 | Missing `--format` / machine output for list/get | Can’t automate | hard | good | **done** | `go-cli.json-without-format` |
| 47 | Silent no-op success (empty branch, stub path) | Scripts think work happened | hard | **best** | **done** | Model prompt priority |
| 48 | Timeout flags not wired to contexts | User `--timeout` ignored | medium | **best** | **done** | Model prompt priority |
| 49 | Model/network broker uses `Background` for short calls | Cancel doesn’t stop paid/remote work | easy | good | **done** | `go-cli.cancellation` + model |
| 50 | Registry/auth helper ignores caller context | Push/pull uncancellable | easy | good | **done** | `go-cli.cancellation` + model |

---

## Coverage summary

| Status | Count (approx) | What it means |
| --- | --- | --- |
| **done** | ~32 | Static rules and/or model prompt/schema coverage |
| **partial** | ~1 | Soft model-only destructive-command guidance |
| **later** | ~13 | High FP risk or low ROI static |
| **out** | 2 | Secrets / credential files (other adversaries) |

---

## Suggested implementation waves

### Wave A — contract credibility (static + light model)
**Shipped:** **1–6**, taste filters, top-3 findings, opinion rewrite, plus **8, 10, 13, 32, 35**.

### Wave B — model-first contract stories
**Shipped:** prompt priorities + schema categories `json-contract`, `deprecation`, `validation-order`, `dry-run` for **7, 9, 12, 15–17, 40, 47–50**. Anti-restatement of pure static lifecycle hits.

### Wave C — framework-aware static
**Shipped:** **23, 26, 28, 29, 46** (`version-identity`, `cobra-silence-usage`, `bare-user-log`, `json-without-format`). **19–20, 24–25** remain later.

### Wave D — architecture / polish
**Shipped:** **34, 37, 41, 42** (`ansi-no-tty`, `option-smuggling-risk`, `init-side-effects`, `os-args-outside-main`). Remaining **later** rows stay documentation/low-ROI.

---

## Explicitly out of scope for go-cli

| Topic | Owner |
| --- | --- |
| Secret scanning / credential entropy | secrets adversary |
| Generic Go style, complexity, tests quality | go-project / go-testing |
| Container / K8s CLI surfaces | domain-specific adversaries |
| Release signing / SBOM | release / supply-chain tooling |

---

## Acceptance bar for adding a pattern

Add a static rule only if:

1. **False-positive rate** is acceptable after path taste (cmd vs scripts).
2. Evidence is a **citable snippet** users can jump to.
3. Recommendation is **actionable** in one sentence.
4. It does not contradict positives (e.g. don’t flag process-boundary `ExitCode` mapping).

Prefer **LLM** when:

1. Correctness depends on **control flow** or **cross-command consistency**.
2. Static would be a brittle string match.
3. The user impact story needs judgment (“silent success”, “schema skew”).

---

## Dogfood anchors (keep green)

On `adversarylabs/adversary` after taste + current dist:

| Should **not** fire | Should **still** fire / observe |
| --- | --- |
| `main.go` `os.Exit(cmd.ExitCode(err))` | `process_adapter` `exec.Command` |
| `cmd/root.go` `NotifyContext(Background)` | OCI auth / model broker `Background` |
| `scripts/**` lifecycle noise | JSON envelope / deprecation notes (model) |

---

## Related docs

- `docs/cli-checklist.md` — shorter coverage status  
- `/tmp/go-cli-top-20.md` (local author notes) — prose checklist source  
- SDK `@adversarylabs/sdk` — `formatOpinion` / `ctx.model.concern` for opinion prose  

---

*Living doc: re-rank after each external CLI dogfood; prefer fewer high-confidence rules over 50 weak ones.*
