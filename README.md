# go/cli

**go/cli** reviews Go command-line applications for predictable **process-boundary** behavior: exit ownership, cancellation, subprocess lifecycle, diagnostics streams, and automation-friendly contracts across Cobra, Viper, Kong, urfave/cli, `flag`, and hand-built commands.

For Cobra commands, that includes proving positional operands are present before `Run` or `RunE` indexes them.

It is a **CLI domain reviewer**, not a general Go linter. It prefers silence over style nits. When it reports, it should be something a staff engineer would block for automation or production CLI reliability.

## What it does

1. **Discovers** non-test Go files used by CLI packages (`*.go`, excluding `*_test.go`).
2. **Runs deterministic detectors** over structure and call sites that emit stable rule ids with file:line evidence.
3. **Synthesizes a review** (severity, impact, recommendation) from those signals.
4. Optionally **enhances** with a model when the CLI provides one (`permissions.model: true`) — explanation and ranking only.

It never executes the scanned project as the product under review, never installs dependencies into it, and never needs network access to the target repository.

## What it detects

Every **shipped rule id**, severity, and short description lives in **[CHECKS.md](CHECKS.md)** — the audit surface for “what does this adversary look for?”

Highlights:

| Area | Examples |
| --- | --- |
| Process ownership | `os.Exit` / `log.Fatal` below main; discarded root `Execute` errors |
| Cancellation | `context.Background`/`TODO` in command work; `exec.Command` without `CommandContext` |
| Injection | `sh -c` / `bash -c` interpolation of composed strings |
| Diagnostics | Progress on stdout; `Output()` discarding stderr; bare `log` for user messaging |
| Contracts | Exit code 2 as catch-all; missing version identity; password flags on argv |

### Ownership boundaries

Other official adversaries own adjacent classes so findings stay non-duplicative:

| Concern | Owned by |
| --- | --- |
| HTTP server/client timeouts for libraries and services | [`go/http`](https://github.com/adversarylabs/go-http-adversary) |
| Concurrent lifecycle / WaitGroup / channel ownership | [`go/concurrency`](https://github.com/adversarylabs/go-concurrency-adversary) |
| High-precision committed secrets | [`security/secrets`](https://github.com/adversarylabs/secrets-adversary) |

## Precision stance

- **High confidence** only for deterministic, evidence-backed patterns.
- Clean fixtures must stay quiet; vulnerable fixtures must fire where graded fixtures exist.
- Prefer missing a weak signal over a false positive on normal production code.
