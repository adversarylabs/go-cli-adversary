package main

import "os"

type command struct{}

func (command) Execute() error { return nil }

func run() {
	rootCmd := command{}
	if err := rootCmd.Execute(); err != nil {
		os.Exit(1)
	}
}
