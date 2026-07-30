package main

import "os/exec"

func run() error {
	return exec.Command("git", "status").Run()
}
