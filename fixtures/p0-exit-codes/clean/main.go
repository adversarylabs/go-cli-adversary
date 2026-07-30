package main

func ExitCode(err error) int {
	if err == nil {
		return 0
	}
	return 1
}

func main() {}
