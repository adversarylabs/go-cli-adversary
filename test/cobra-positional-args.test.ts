import assert from "node:assert/strict";
import test from "node:test";
import { analyzeDiscovery } from "../src/analyze.ts";

const ruleId = "go-cli.cobra-positional-args-minimum";

async function signals(source: string) {
  const analysis = await analyzeDiscovery({
    mode: "repository",
    files: [{ path: "cmd/search.go", current: source, changedLines: new Set(), status: "repository" }],
  });
  assert.deepEqual(analysis.parseErrors, []);
  return analysis.signals.filter((signal) => signal.ruleId === ruleId);
}

function command(fields: string, importName = "cobra") {
  const importSpec = importName === "cobra"
    ? '"github.com/spf13/cobra"'
    : `${importName} "github.com/spf13/cobra"`;
  return `package cmd

import ${importSpec}

func newSearchCommand() *${importName}.Command {
	return &${importName}.Command{
${fields}
	}
}
`;
}

test("flags args[0] when MaximumNArgs allows an empty invocation", async () => {
  const source = command(`		Use: "search [vulnerability_id]",
		Args: cobra.MaximumNArgs(1),
		RunE: func(_ *cobra.Command, args []string) error {
			id := args[0]
			return search(id)
		},`);
  const found = await signals(source);
  assert.equal(found.length, 1);
  assert.equal(found[0]?.snippet, "args[0]");
  assert.deepEqual(found[0]?.data, {
    requiredMinimum: 1,
    validatorMinimum: 0,
    access: "args[0]",
    accessLine: 10,
  });
});

test("flags slicing beyond the unproven positional minimum", async () => {
  const source = command(`		Use: "search [ids...]",
		Run: func(_ *cobra.Command, args []string) {
			consume(args[2:])
		},`);
  const found = await signals(source);
  assert.equal(found.length, 1);
  assert.equal(found[0]?.snippet, "args[2:]");
  assert.equal(found[0]?.data.requiredMinimum, 2);
});

test("accepts Cobra validators that mechanically prove the required minimum", async () => {
  for (const validator of [
    "cobra.ExactArgs(1)",
    "cobra.MinimumNArgs(1)",
    "cobra.RangeArgs(1, 3)",
  ]) {
    const source = command(`		Args: ${validator},
		RunE: func(_ *cobra.Command, args []string) error {
			return search(args[0])
		},`);
    assert.deepEqual(await signals(source), [], validator);
  }
});

test("accepts mechanically proven inline and same-file custom validators", async () => {
  const inline = command(`		Args: func(_ *cobra.Command, args []string) error {
			if len(args) < 1 { return errors.New("missing id") }
			return nil
		},
		RunE: func(_ *cobra.Command, args []string) error { return search(args[0]) },`)
    .replace('import "github.com/spf13/cobra"', 'import (\n\t"errors"\n\t"github.com/spf13/cobra"\n)');
  assert.deepEqual(await signals(inline), []);

  const named = command(`		Args: requireID,
		RunE: func(_ *cobra.Command, args []string) error { return search(args[0]) },`)
    .replace("func newSearchCommand", `func requireID(_ *cobra.Command, args []string) error {
	if len(args) == 0 { return errors.New("missing id") }
	return nil
}

func newSearchCommand`)
    .replace('import "github.com/spf13/cobra"', 'import (\n\t"errors"\n\t"github.com/spf13/cobra"\n)');
  assert.deepEqual(await signals(named), []);
});

test("does not trust a custom validator whose rejection can return nil", async () => {
  const source = command(`		Args: func(_ *cobra.Command, args []string) error {
			if len(args) < 1 { return maybeError() }
			return nil
		},
		RunE: func(_ *cobra.Command, args []string) error { return search(args[0]) },`);
  // Unknown validators fail closed rather than asserting that their contract
  // is insufficient; maybeError may or may not reject the invocation.
  assert.deepEqual(await signals(source), []);
});

test("accepts dominating guards and exact switch cases", async () => {
  const guarded = command(`		Args: cobra.MaximumNArgs(1),
		RunE: func(_ *cobra.Command, args []string) error {
			if len(args) < 1 { return errors.New("missing id") }
			return search(args[0])
		},`).replace(
    'import "github.com/spf13/cobra"',
    'import (\n\t"errors"\n\t"github.com/spf13/cobra"\n)',
  );
  assert.deepEqual(await signals(guarded), []);

  const switched = command(`		Args: cobra.MaximumNArgs(1),
		RunE: func(_ *cobra.Command, args []string) error {
			switch len(args) {
			case 1:
				return search(args[0])
			default:
				return errors.New("missing id")
			}
		},`).replace(
    'import "github.com/spf13/cobra"',
    'import (\n\t"errors"\n\t"github.com/spf13/cobra"\n)',
  );
  assert.deepEqual(await signals(switched), []);
});

test("accepts a dominating guard in every enclosing block", async () => {
  const source = command(`		Args: cobra.MaximumNArgs(1),
		RunE: func(_ *cobra.Command, args []string) error {
			if enabled {
				if len(args) == 0 { return errors.New("missing id") }
				return search(args[0])
			}
			return nil
		},`).replace(
    'import "github.com/spf13/cobra"',
    'import (\n\t"errors"\n\t"github.com/spf13/cobra"\n)',
  );
  assert.deepEqual(await signals(source), []);
});

test("does not mistake a conditional panic for an unconditional exit", async () => {
  const conditional = command(`		RunE: func(_ *cobra.Command, args []string) error {
			if len(args) == 0 { if debug { panic("debug") } }
			return search(args[0])
		},`);
  assert.equal((await signals(conditional)).length, 1);

  const direct = command(`		RunE: func(_ *cobra.Command, args []string) error {
			if len(args) == 0 { panic("missing id") }
			return search(args[0])
		},`);
  assert.deepEqual(await signals(direct), []);
});

test("does not confuse os.Args or arbitrary slices with Cobra positional args", async () => {
  const source = command(`		RunE: func(_ *cobra.Command, args []string) error {
			_ = os.Args[1]
			values := []string{}
			_ = values[0]
			return nil
		},`).replace(
    'import "github.com/spf13/cobra"',
    'import (\n\t"os"\n\t"github.com/spf13/cobra"\n)',
  );
  assert.deepEqual(await signals(source), []);

  const nonCobra = `package cmd
func run(args []string) string { return args[0] }
`;
  assert.deepEqual(await signals(nonCobra), []);
});

test("ignores nested closures and block-local slices that shadow the positional parameter", async () => {
  const source = command(`		RunE: func(_ *cobra.Command, args []string) error {
			visit := func(args []string) { println(args[0]) }
			visit([]string{"safe"})
			{
				args := []string{"also-safe"}
				println(args[0])
			}
			return nil
		},`);
  assert.deepEqual(await signals(source), []);
});

test("ignores range, initializer, and var declarations that shadow callback args", async () => {
  const source = command(`		RunE: func(_ *cobra.Command, args []string) error {
			for _, args := range [][]string{{"safe"}} { println(args[0]) }
			if args := []string{"safe"}; enabled { println(args[0]) }
			{
				var args = []string{"safe"}
				println(args[0])
			}
			return nil
		},`);
  assert.deepEqual(await signals(source), []);
});

test("resets validator and guard proofs when positional args may be reassigned", async () => {
  const unsafe = command(`		Args: cobra.ExactArgs(1),
		RunE: func(_ *cobra.Command, args []string) error {
			args = maybeEmpty(args)
			return search(args[0])
		},`);
  assert.equal((await signals(unsafe)).length, 1);

  const guarded = command(`		Args: cobra.ExactArgs(1),
		RunE: func(_ *cobra.Command, args []string) error {
			if len(args) > 0 {
				args = maybeEmpty(args)
				if len(args) == 0 { return errors.New("empty") }
				return search(args[0])
			}
			return nil
		},`).replace(
    'import "github.com/spf13/cobra"',
    'import (\n\t"errors"\n\t"github.com/spf13/cobra"\n)',
  );
  assert.deepEqual(await signals(guarded), []);

  const knownNonEmpty = command(`		Args: cobra.ExactArgs(1),
		RunE: func(_ *cobra.Command, args []string) error {
			args = []string{"replacement"}
			return search(args[0])
		},`);
  assert.deepEqual(await signals(knownNonEmpty), []);

  const unreachable = command(`		Args: cobra.ExactArgs(1),
		RunE: func(_ *cobra.Command, args []string) error {
			if debug { args = maybeEmpty(args); return nil }
			return search(args[0])
		},`);
  assert.deepEqual(await signals(unreachable), []);

  const conditional = command(`		Args: cobra.ExactArgs(1),
		RunE: func(_ *cobra.Command, args []string) error {
			if debug { args = maybeEmpty(args) }
			return search(args[0])
		},`);
  assert.equal((await signals(conditional)).length, 1);

  const conditionallyGuarded = command(`		Args: cobra.ExactArgs(1),
		RunE: func(_ *cobra.Command, args []string) error {
			if debug {
				args = maybeEmpty(args)
				if len(args) == 0 { return errors.New("empty") }
			}
			return search(args[0])
		},`).replace(
    'import "github.com/spf13/cobra"',
    'import (\n\t"errors"\n\t"github.com/spf13/cobra"\n)',
  );
  assert.deepEqual(await signals(conditionallyGuarded), []);
});

test("resolves exact same-file named Cobra callbacks without following arbitrary helpers", async () => {
  const unsafe = `package cmd

import "github.com/spf13/cobra"

func runSearch(_ *cobra.Command, values []string) error { return search(values[0]) }

func newSearchCommand() *cobra.Command {
	return &cobra.Command{Args: cobra.MaximumNArgs(1), RunE: runSearch}
}
`;
  assert.equal((await signals(unsafe)).length, 1);

  const safe = unsafe.replace("cobra.MaximumNArgs(1)", "cobra.MinimumNArgs(1)");
  assert.deepEqual(await signals(safe), []);

  const namedResult = unsafe.replace(
    "func runSearch(_ *cobra.Command, values []string) error",
    "func runSearch(_ *cobra.Command, values []string) (err error)",
  );
  assert.equal((await signals(namedResult)).length, 1);

  const shadowed = unsafe.replace(
    "\treturn &cobra.Command",
    "\trunSearch := externalHandler\n\treturn &cobra.Command",
  );
  assert.deepEqual(await signals(shadowed), []);

  const wrongSignature = unsafe.replace(
    "func runSearch(_ *cobra.Command, values []string) error",
    "func runSearch(values []string) error",
  );
  assert.deepEqual(await signals(wrongSignature), []);

  const namedRun = unsafe
    .replace("func runSearch(_ *cobra.Command, values []string) error { return search(values[0]) }", "func runSearch(_ *cobra.Command, values []string) { search(values[0]) }")
    .replace("RunE: runSearch", "Run: runSearch");
  assert.equal((await signals(namedRun)).length, 1);

  const parameterShadow = unsafe
    .replace("func newSearchCommand()", "func newSearchCommand(runSearch func(*cobra.Command, []string) error)");
  assert.deepEqual(await signals(parameterShadow), []);
});

test("recognizes a renamed Cobra import and stays quiet for unknown custom validators", async () => {
  const aliased = command(`		Args: cli.MaximumNArgs(1),
		RunE: func(_ *cli.Command, values []string) error { return search(values[0]) },`, "cli");
  assert.equal((await signals(aliased)).length, 1);

  const external = command(`		Args: validateSearchArgs,
		RunE: func(_ *cobra.Command, args []string) error { return search(args[0]) },`);
  assert.deepEqual(await signals(external), []);
});
