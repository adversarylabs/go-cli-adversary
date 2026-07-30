package main

func ExitCode(err error) int {
	if err == nil {
		return 0
	}
	// Catch-all runtime failure mapped to 2 (usage convention).
	return 2
}

func main() {}
