package main

import "flag"

func main() {
	// Secret accepted on argv (visible in ps).
	_ = flag.String("password", "", "database password")
	flag.Parse()
}
