# Go CLI adversary

Go CLI reviews command-line applications for predictable cancellation, diagnostics, cleanup, and automation behavior across Cobra, Viper, Kong, urfave/cli, `flag`, and hand-built commands.

It reviews process-boundary ownership, cancellation, and subprocess safety:

- direct process termination (`os.Exit`, `log.Fatal*`, common logger Fatals)
- discarded root command execution errors
- work started from `context.Background` / `context.TODO`
- `exec.Command` without `CommandContext`
- shell `sh -c` / `bash -c` interpolation

See [docs/cli-checklist.md](docs/cli-checklist.md) for roadmap coverage against a broader Go CLI checklist.

## Fixtures and calibration

Five graded fixtures own expected review snapshots. The 61-repository benchmark index calibrates command lifecycle and configuration judgment without copying source.

## Automatic detection

`adversary auto` selects Go CLI when Go command entrypoints or files under `cmd/` change.

## Development

Run `npm test`, `adversary validate .`, and `adversary pack --check .`.
