package excellent

import "context"

type command struct{ ctx context.Context }

func (c command) Context() context.Context { return c.ctx }

func run(cmd command) error { return work(cmd.Context()) }

func work(context.Context) error { return nil }
