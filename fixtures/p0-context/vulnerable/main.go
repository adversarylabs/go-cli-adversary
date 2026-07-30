package main

import "context"

func run() error {
	// Long-running work starts from a non-cancellable context.
	return work(context.Background())
}

func work(ctx context.Context) error {
	_ = ctx
	return nil
}
