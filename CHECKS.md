# Checks

| Rule | Severity | Scans for |
| --- | --- | --- |
| `go-cli.ansi-no-tty` | Low | ANSI/spinner without terminal guard |
| `go-cli.bare-user-log` | Low | Bare log package for user messaging |
| `go-cli.broad-process-kill` | High | Process cleanup uses a broad pattern kill |
| `go-cli.cancellation` | Medium | Long-running work starts from non-cancellable context |
| `go-cli.cobra-positional-args-minimum` | High | A Cobra `Run`/`RunE` callback indexes or slices positional `args` beyond the minimum its validator or control flow proves present |
| `go-cli.cobra-silence-usage` | Low | Cobra command does not silence usage on runtime errors |
| `go-cli.destructive-force` | Medium | A destructive infrastructure command is forced without a dry-run path |
| `go-cli.execute-error` | High | Root command error is discarded |
| `go-cli.exit-bypass` | High | Command code terminates the process directly |
| `go-cli.exit-code-convention` | Medium | Exit code 2 used as catch-all runtime failure |
| `go-cli.flags-password-argv` | High | Password/token-like secrets on CLI argv |
| `go-cli.http-no-timeout` | Medium | HTTP client has no timeout budget |
| `go-cli.init-side-effects` | Low | Package init performs I/O or client construction |
| `go-cli.interactive-no-tty` | Medium | Interactive input without non-TTY guard |
| `go-cli.json-without-format` | Medium | JSON on stdout without an obvious format switch |
| `go-cli.option-smuggling-risk` | Medium | Revision-like args passed to subprocess without validation |
| `go-cli.orphan-long-running-child` | Medium | A long-running child is started without recorded ownership |
| `go-cli.os-args-outside-main` | Low | Library/command package reads os.Args directly |
| `go-cli.shell-interpolation` | High | Shell used to interpolate a command string |
| `go-cli.silence-usage` | Low | Cobra does not silence usage on runtime errors |
| `go-cli.stdout-progress` | Medium | Progress/diagnostics written to stdout |
| `go-cli.subprocess-no-context` | Medium | Subprocess without CommandContext |
| `go-cli.subprocess-stderr-discarded` | Medium | Stdout captured while stderr discarded |
| `go-cli.update-insecure` | High | Self-update or release download is insecure |
| `go-cli.version-identity` | Low | CLI root lacks inspectable version identity |

## Model-reviewed CLI contract principles

The bounded model review also checks evidence-heavy CLI contracts that are not safe to infer from syntax alone:

- **Cancellation swallowed by best-effort recovery.** Trace command-context cancellation through warning/fallback/retry branches to continued work or success. Require evidence of the cancellation source, swallowing branch, and unguarded consequence. Propagation, caller/downstream checks, recoverable child timeouts with a live parent, and bounded cleanup stay quiet.
- **Provisional configuration placement.** Report only when changed source explicitly identifies a consumed setting as experimental or subject to incompatible feedback-driven changes, the same CLI already has an experimental configuration boundary, and the setting is introduced outside it. Novelty alone is not evidence. Stable commitments, compatibility aliases, missing or unsuitable experimental boundaries, and already-promoted settings stay quiet.
- **Operation-family configuration completeness.** Report only when changed runtime source proves one mechanism applies to a concrete sibling operation family, changed operation-specific configuration exposes only a subset, and a proven omitted supported sibling has no aggregate, inherited, or separate equivalent configuration path. Naming similarity, unsupported or fixed-policy operations, and documented authorization, transport, or lifecycle boundaries stay quiet.
- **Sibling-mode operand grammar.** Report only when prepared source proves existing sibling modes accept the same conceptual operand through one established grouping/arity/delimiter grammar and the changed mode parses that operand differently. Different commands or meanings, explicit compatibility extensions, shared normalization, aliases, incomplete sibling evidence, and style-only differences stay quiet.

Findings must cite the prepared source that proves both sides of the relevant contract boundary. One high-confidence finding per distinct contract gap is preferred.

## Miss-derived review boundary

- Trace partial command commits: when an import/install command commits durable content and then binds the requested name or reference in a separate fallible step, inspect the failure return and the store's recovery/ownership contract. Report only when source proves the command promises an atomic usable installation or the leftover state causes a concrete retry, visibility, quota, or cleanup failure. Cite both commit boundaries and the failed user-visible outcome. Recommend an atomic transaction, staged publish, or ownership-safe compensation as appropriate. Never recommend deleting shared content blindly: another reference or concurrent operation may own it. Stay quiet when retained content is an intentional reusable cache, retries safely reuse it and complete the binding, failure clearly reports partial success with supported recovery, or rollback/garbage collection satisfies the established contract. A nonzero exit after a write alone is not a defect.
