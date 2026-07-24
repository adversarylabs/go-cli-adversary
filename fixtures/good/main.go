package good

import "flag"

func parse(args []string) error {
	flags := flag.NewFlagSet("sample", flag.ContinueOnError)
	return flags.Parse(args)
}
