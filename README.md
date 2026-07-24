# Go CLI adversary

Go CLI reviews command-line applications for predictable cancellation, diagnostics, cleanup, and automation behavior across Cobra, Viper, Kong, urfave/cli, `flag`, and hand-built commands.

It currently reviews direct process termination below `main`, discarded command execution errors, and command work detached from the inherited context.

## Fixtures and calibration

Five graded fixtures own expected review snapshots. The 61-repository benchmark index calibrates command lifecycle and configuration judgment without copying source.

## Automatic detection

`adversary auto` selects Go CLI when Go command entrypoints or files under `cmd/` change.

## Development

Run `npm test`, `adversary validate .`, and `adversary pack --check .`.
