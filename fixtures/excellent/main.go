package excellent

import (
	"context"
	"os/exec"
)

type command struct{ ctx context.Context }

func (c command) Context() context.Context { return c.ctx }

func run(cmd command) error {
	return work(cmd.Context())
}

func work(ctx context.Context) error {
	command := exec.CommandContext(ctx, "git", "status", "--porcelain")
	return command.Run()
}
