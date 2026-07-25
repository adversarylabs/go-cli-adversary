package average

import (
	"context"
	"os/exec"
)

func run() error {
	_ = context.TODO()
	return work(context.Background())
}

func work(ctx context.Context) error {
	_ = exec.Command("git", "status")
	return nil
}
