package terrible

import (
	"context"
	"os"
)

type command struct{}

func (command) Execute() error { return nil }

func run() {
	rootCmd := command{}
	rootCmd.Execute()
	_ = context.Background()
	os.Exit(0)
}
