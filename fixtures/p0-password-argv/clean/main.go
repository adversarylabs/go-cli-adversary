package main

import "flag"

func main() {
	// Prefer file path or env; no credential flag name on argv.
	_ = flag.String("password-file", "", "path to password file")
	flag.Parse()
}
