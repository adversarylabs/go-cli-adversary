package main

import "context"

type command struct{ ctx context.Context }

func (c command) Context() context.Context { return c.ctx }

func run(cmd command) error {
	return work(cmd.Context())
}

func work(ctx context.Context) error {
	_ = ctx
	return nil
}
