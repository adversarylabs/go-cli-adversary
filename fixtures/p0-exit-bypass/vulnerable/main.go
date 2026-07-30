package main

import "log"

func runCommand() {
	// Terminates the process below the application boundary.
	log.Fatal("boom")
}

func main() {}
