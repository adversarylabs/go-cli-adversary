package terrible

import (
	"context"
	"log"
	"os"
	"os/exec"
)

type command struct{}

func (command) Execute() error { return nil }

func run() {
	rootCmd := command{}
	rootCmd.Execute()
	_ = context.Background()
	_ = context.TODO()
	log.Fatal("boom")
	os.Exit(0)
	_ = exec.Command("git", "status")
	_ = exec.Command("sh", "-c", "echo "+os.Getenv("USER"))
}
