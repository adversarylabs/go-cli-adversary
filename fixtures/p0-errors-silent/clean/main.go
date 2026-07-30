package main

import (
	"fmt"
	"os"
)

type command struct{}

func (command) Execute() error { return nil }

func run() {
	cmd := command{}
	if err := cmd.Execute(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
