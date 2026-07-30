package main

type command struct{}

func (command) Execute() error { return nil }

func run() {
	rootCmd := command{}
	rootCmd.Execute()
}
