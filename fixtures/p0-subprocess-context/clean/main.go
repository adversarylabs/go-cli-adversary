package main

import (
	"context"
	"os/exec"
)

func run(ctx context.Context) error {
	return exec.CommandContext(ctx, "git", "status").Run()
}
