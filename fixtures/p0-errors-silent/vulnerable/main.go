package main

type command struct{}

func (command) Execute() error { return nil }

func run() {
	cmd := command{}
	// Silent discard of root command error.
	_ = cmd.Execute()
}
