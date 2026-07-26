# Go CLI adversary

Go CLI reviews command-line applications for predictable cancellation, diagnostics, cleanup, and automation behavior across Cobra, Viper, Kong, urfave/cli, `flag`, and hand-built commands.

It reviews process-boundary ownership, cancellation, and subprocess safety:

- direct process termination (`os.Exit`, `log.Fatal*`, common logger Fatals)
- discarded root command execution errors
- work started from `context.Background` / `context.TODO`
- `exec.Command` without `CommandContext`
- shell `sh -c` / `bash -c` interpolation

See [docs/cli-checklist.md](docs/cli-checklist.md) for roadmap coverage against a broader Go CLI checklist.

## Model-assisted CLI review

When the Adversary CLI provides a model broker (`permissions.model: true`), go-cli keeps
deterministic discovery and lifecycle findings, then asks the model for a small number of
high-confidence CLI-contract observations (flags, exit/stream contracts, cancellation stories,
automation compatibility, incomplete command paths). Provider credentials and model selection
stay in the CLI; this package only calls `ctx.model.review(...)`.

Runtime model calls require a CLI build that includes the model-broker feature. Unit tests inject
a deterministic `ReviewModel` and never call a live provider.

## Fixtures and calibration

Five graded fixtures own expected review snapshots. The 61-repository benchmark index calibrates command lifecycle and configuration judgment without copying source.

## Automatic detection

`adversary auto` selects Go CLI when Go command entrypoints or files under `cmd/` change.

## Development

Run `npm test`, `adversary validate .`, and `adversary pack --check .`.

## Project

Source is available in the [Go CLI adversary repository](https://github.com/adversarylabs/go-cli-adversary). Go CLI is licensed under the [MIT License](LICENSE).
