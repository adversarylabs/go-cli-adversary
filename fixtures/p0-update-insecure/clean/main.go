package main

import "net/http"

func downloadUpdate() error {
	resp, err := http.Get("https://example.com/releases/download/v1.0.0/cli")
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	return nil
}

func main() {}
