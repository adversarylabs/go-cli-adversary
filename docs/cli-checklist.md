# Go CLI checklist coverage

Product roadmap for go-cli, derived from the “top 20 things a Go CLI should do”
checklist. Prefer high-confidence, evidence-backed findings over soft style notes.

| Theme | Status | Rule / notes |
| --- | --- | --- |
| Exit only at process boundary | Covered | `go-cli.exit-bypass` (`os.Exit`, `log.Fatal*`, common logger Fatals) |
| Handle root command errors | Covered | `go-cli.execute-error` |
| Propagate cancellation | Covered | `go-cli.cancellation` (`context.Background`, `context.TODO`) |
| Subprocess inherits context | Covered | `go-cli.subprocess-no-context` / positive `go-cli.subprocess-context` |
| Avoid shell `-c` interpolation | Covered | `go-cli.shell-interpolation` |
| Validate before side effects | Planned | Needs structure-aware heuristics |
| stdout vs stderr | Planned | Narrow TTY/progress and JSON-mix patterns |
| Version identity | Planned | Presence as positive; absence only with high confidence |
| Completions | Later | Low severity |
| Config precedence | Later | Framework-specific |
| Secrets / credential files | Out of scope | Prefer secrets adversary |
| General Go style | Out of scope | Prefer go-project / go-security |

## Severity policy

- Lifecycle / trust / injection → medium–high  
- Version / completions → low or informational  
- Soft design guidance → documentation or opinion, not findings  

## Judgment policy

- Emit at most **3** findings, ordered by severity then occurrence count.  
- Attach `metadata.occurrences` (true hit total) and a small evidence sample.  
- Prefer **command paths** (`cmd/`, `cli/`, `main.go`, `internal/cmd|cli|app`) for
  cancellation and subprocess rules when those paths have hits.  
- Assessment lists priority issues in fix order; opinion names the primary concern.  
