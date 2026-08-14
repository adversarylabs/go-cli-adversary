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

  const guardedByElseExit = command(`		Args: cobra.ExactArgs(1),
		RunE: func(_ *cobra.Command, args []string) error {
			if debug {
				args = maybeEmpty(args)
				if len(args) > 0 { note() } else { return errors.New("empty") }
			}
			return search(args[0])
		},`).replace(
    'import "github.com/spf13/cobra"',
    'import (\n\t"errors"\n\t"github.com/spf13/cobra"\n)',
  );
  assert.deepEqual(await signals(guardedByElseExit), []);
});

test("proves branch-sensitive exits but not an unsafe fallthrough", async () => {
  const safe = command(`		Args: cobra.MaximumNArgs(1),
		RunE: func(_ *cobra.Command, args []string) error {
			if len(args) > 0 { note() } else { return errors.New("missing") }
			return search(args[0])
		},`).replace(
    'import "github.com/spf13/cobra"',
    'import (\n\t"errors"\n\t"github.com/spf13/cobra"\n)',
  );
  assert.deepEqual(await signals(safe), []);

  const unsafe = safe.replace('else { return errors.New("missing") }', "else { note() }");
  assert.equal((await signals(unsafe)).length, 1);
});

test("proves loop-condition and continue guards only on their guarded iterations", async () => {
  const conditional = command(`		RunE: func(_ *cobra.Command, args []string) error {
			for len(args) > 0 { return search(args[0]) }
			return nil
		},`);
  assert.deepEqual(await signals(conditional), []);

  const continued = command(`		RunE: func(_ *cobra.Command, args []string) error {
			for {
				if len(args) == 0 { continue }
				return search(args[0])
			}
		},`);
  assert.deepEqual(await signals(continued), []);

  const unsafe = continued.replace("if len(args) == 0 { continue }", "if len(args) == 0 && retry { continue }");
  assert.equal((await signals(unsafe)).length, 1);
});

test("proves exhaustive switch length exits and rejects partial or breaking cases", async () => {
  const exhaustive = command(`		RunE: func(_ *cobra.Command, args []string) error {
			switch len(args) {
			case 0: return errors.New("missing")
			default: return search(args[0])
			}
		},`).replace(
    'import "github.com/spf13/cobra"',
    'import (\n\t"errors"\n\t"github.com/spf13/cobra"\n)',
  );
  assert.deepEqual(await signals(exhaustive), []);

  const prior = command(`		RunE: func(_ *cobra.Command, args []string) error {
			switch len(args) { case 0: return errors.New("missing") }
			return search(args[0])
		},`).replace(
    'import "github.com/spf13/cobra"',
    'import (\n\t"errors"\n\t"github.com/spf13/cobra"\n)',
  );
  assert.deepEqual(await signals(prior), []);

  const partial = prior.replace("args[0]", "args[1]");
  assert.equal((await signals(partial)).length, 1);

  const breaking = prior.replace('return errors.New("missing")', "break");
  assert.equal((await signals(breaking)).length, 1);
});

test("analyzes invoked closures while leaving stored closures out of scope", async () => {
  const direct = command(`		RunE: func(_ *cobra.Command, args []string) error {
			func() { use(args[0]) }()
			return nil
		},`);
  assert.equal((await signals(direct)).length, 1);

  const deferred = direct.replace("func() { use(args[0]) }()", "defer func() { use(args[0]) }()\n\t\t\tif len(args) == 0 { return nil }");
  assert.equal((await signals(deferred)).length, 1);

  const guardedDefer = direct.replace("func() { use(args[0]) }()", "if len(args) == 0 { return nil }\n\t\t\tdefer func() { use(args[0]) }()");
  assert.deepEqual(await signals(guardedDefer), []);

  const deferredLaterWrite = command(`		Args: cobra.ExactArgs(1),
		RunE: func(_ *cobra.Command, args []string) error {
			defer func() { use(args[0]) }()
			args = maybeEmpty(args)
			return nil
		},`);
  assert.equal((await signals(deferredLaterWrite)).length, 1);

  const deferredInnerGuard = deferredLaterWrite.replace(
    "defer func() { use(args[0]) }()",
    "defer func() { if len(args) > 0 { use(args[0]) } }()",
  );
  assert.deepEqual(await signals(deferredInnerGuard), []);

  const launched = direct.replace("func() { use(args[0]) }()", "go func() { use(args[0]) }()");
  assert.equal((await signals(launched)).length, 1);

  const launchedLaterWrite = deferredLaterWrite.replace("defer func()", "go func()");
  assert.equal((await signals(launchedLaterWrite)).length, 1);

  const stored = direct.replace("func() { use(args[0]) }()", "later := func() { use(args[0]) }\n\t\t\t_ = later");
  assert.deepEqual(await signals(stored), []);

  const shadowed = direct.replace("func() { use(args[0]) }()", 'func(args []string) { use(args[0]) }([]string{"safe"})');
  assert.deepEqual(await signals(shadowed), []);
});

test("uses the last reachable positional-args write and ignores identity writes", async () => {
  const safe = command(`		Args: cobra.ExactArgs(1),
		RunE: func(_ *cobra.Command, args []string) error {
			if debug { args = maybeEmpty(args) }
			args = []string{"safe"}
			return search(args[0])
		},`);
  assert.deepEqual(await signals(safe), []);

  const identity = safe.replace('if debug { args = maybeEmpty(args) }\n\t\t\targs = []string{"safe"}', "args = args");
  assert.deepEqual(await signals(identity), []);

  const unsafe = safe.replace('args = []string{"safe"}', "args = maybeEmpty(args)");
  assert.equal((await signals(unsafe)).length, 1);

  const invokedAssignment = command(`		Args: cobra.ExactArgs(1),
		RunE: func(_ *cobra.Command, args []string) error {
			func() { args = maybeEmpty(args); use(args[0]) }()
			return nil
		},`);
  assert.equal((await signals(invokedAssignment)).length, 1);
});

test("recognizes select receive declarations that shadow callback args", async () => {
  const source = command(`		RunE: func(_ *cobra.Command, args []string) error {
			select {
			case args := <-ch:
				use(args[0])
			default:
			}
			return nil
		},`);
  assert.deepEqual(await signals(source), []);
});

test("keeps adjacent nested control-flow proofs conservative", async () => {
  const nestedExit = command(`		RunE: func(_ *cobra.Command, args []string) error {
			if len(args) == 0 {
				if debug { return errors.New("missing") } else { panic("missing") }
			}
			return search(args[0])
		},`).replace(
    'import "github.com/spf13/cobra"',
    'import (\n\t"errors"\n\t"github.com/spf13/cobra"\n)',
  );
  assert.deepEqual(await signals(nestedExit), []);

  const nestedFallthrough = nestedExit.replace('else { panic("missing") }', "else { note() }");
  assert.equal((await signals(nestedFallthrough)).length, 1);

  const switchLoop = command(`		RunE: func(_ *cobra.Command, args []string) error {
			for {
				switch len(args) {
				case 0: continue
				default: return search(args[0])
				}
			}
		},`);
  assert.deepEqual(await signals(switchLoop), []);

  const labeled = command(`		RunE: func(_ *cobra.Command, args []string) error {
		outer: for {
				if len(args) == 0 { continue outer }
				return search(args[0])
			}
		},`);
  assert.equal((await signals(labeled)).length, 1);
});

test("accounts for predecessor fallthrough in length switch cases", async () => {
  const unsafe = command(`		RunE: func(_ *cobra.Command, args []string) error {
			switch len(args) {
			case 0: fallthrough
			case 1: return search(args[0])
			default: return nil
			}
		},`);
  assert.equal((await signals(unsafe)).length, 1);

  const safe = unsafe.replace("case 0: fallthrough\n\t\t\tcase 1", "case 1: fallthrough\n\t\t\tcase 2");
  assert.deepEqual(await signals(safe), []);

  const siblingWrite = command(`		Args: cobra.ExactArgs(1),
		RunE: func(_ *cobra.Command, args []string) error {
			switch mode {
			case "replace": args = maybeEmpty(args)
			default: return search(args[0])
			}
			return nil
		},`);
  assert.deepEqual(await signals(siblingWrite), []);

  const fallingWrite = siblingWrite.replace(
    'case "replace": args = maybeEmpty(args)',
    'case "replace": args = maybeEmpty(args); fallthrough',
  );
  assert.equal((await signals(fallingWrite)).length, 1);
});

test("trusts only the unshadowed builtin panic as a terminal guard", async () => {
  const guarded = command(`		RunE: func(_ *cobra.Command, args []string) error {
			if len(args) == 0 { panic("missing") }
			return search(args[0])
		},`);
  assert.deepEqual(await signals(guarded), []);

  const packageShadow = guarded.replace(
    "func newSearchCommand",
    "func panic(any) {}\n\nfunc newSearchCommand",
  );
  assert.equal((await signals(packageShadow)).length, 1);

  const localShadow = guarded.replace(
    "if len(args) == 0",
    "panic := func(any) {}\n\t\t\tif len(args) == 0",
  );
  assert.equal((await signals(localShadow)).length, 1);
});

test("models direct, deferred, and goroutine closure writes by execution time", async () => {
  const deferred = command(`		Args: cobra.ExactArgs(1),
		RunE: func(_ *cobra.Command, args []string) error {
			defer func() { args = maybeEmpty(args) }()
			return search(args[0])
		},`);
  assert.deepEqual(await signals(deferred), []);

  const direct = deferred.replace("defer func()", "func()");
  assert.equal((await signals(direct)).length, 1);

  const concurrent = deferred.replace("defer func()", "go func()");
  assert.equal((await signals(concurrent)).length, 1);
});

test("distinguishes select receive reassignment from short-declaration shadowing", async () => {
  const reassigned = command(`		Args: cobra.ExactArgs(1),
		RunE: func(_ *cobra.Command, args []string) error {
			select { case args = <-ch: return search(args[0]); default: return nil }
		},`);
  assert.equal((await signals(reassigned)).length, 1);

  const shadowed = reassigned.replace("args = <-ch", "args := <-ch");
  assert.deepEqual(await signals(shadowed), []);

  const sibling = command(`		Args: cobra.ExactArgs(1),
		RunE: func(_ *cobra.Command, args []string) error {
			select {
			case args = <-ch: return nil
			case <-ready: return search(args[0])
			}
		},`);
  assert.deepEqual(await signals(sibling), []);
});

test("does not resolve shadowed validator or error-constructor bindings", async () => {
  const localValidator = `package cmd

import (
	"errors"
	"github.com/spf13/cobra"
)

func requireID(_ *cobra.Command, args []string) error {
	if len(args) < 1 { return errors.New("missing") }
	return nil
}

func newSearchCommand() *cobra.Command {
	requireID := externalValidator
	return &cobra.Command{Args: requireID, RunE: func(_ *cobra.Command, args []string) error {
		return search(args[1])
	}}
}
`;
  assert.deepEqual(await signals(localValidator), []);

  const localErrors = command(`		Args: func(_ *cobra.Command, args []string) error {
			errors := fakeErrors{}
			if len(args) < 1 { return errors.New("missing") }
			return nil
		},
		RunE: func(_ *cobra.Command, args []string) error { return search(args[1]) },`)
    .replace('import "github.com/spf13/cobra"', 'import (\n\t"errors"\n\t"github.com/spf13/cobra"\n)');
  assert.deepEqual(await signals(localErrors), []);
});

test("proves the minimum preserved or added by append", async () => {
  const added = command(`		RunE: func(_ *cobra.Command, args []string) error {
			args = append(args, "fallback")
			return search(args[0])
		},`);
  assert.deepEqual(await signals(added), []);

  const unknownSpread = added.replace('append(args, "fallback")', "append(args, more...)");
  assert.equal((await signals(unknownSpread)).length, 1);

  const preserved = unknownSpread.replace("RunE:", "Args: cobra.ExactArgs(1),\n\t\tRunE:");
  assert.deepEqual(await signals(preserved), []);
});

test("parses Go integer literal forms in accesses, validators, and guards", async () => {
  for (const [literal, required] of [
    ["0b10", 3],
    ["0o10", 9],
    ["010", 9],
    ["0x10", 17],
    ["1_0", 11],
  ] as const) {
    const unsafe = command(`		Args: cobra.MaximumNArgs(32),
		RunE: func(_ *cobra.Command, args []string) error { return search(args[${literal}]) },`);
    const found = await signals(unsafe);
    assert.equal(found.length, 1, literal);
    assert.equal(found[0]?.data.requiredMinimum, required, literal);

    const guarded = command(`		RunE: func(_ *cobra.Command, args []string) error {
			if len(args) < ${literal} + 1 { return errors.New("missing") }
			return search(args[${literal}])
		},`).replace(
      'import "github.com/spf13/cobra"',
      'import (\n\t"errors"\n\t"github.com/spf13/cobra"\n)',
    );
    // Arithmetic guard expressions are intentionally outside the exact proof.
    assert.equal((await signals(guarded)).length, 1, `arithmetic ${literal}`);
  }

  for (const literal of ["0b1", "0o1", "01", "0x1", "0_1"]) {
    const safe = command(`		Args: cobra.MinimumNArgs(${literal}),
		RunE: func(_ *cobra.Command, args []string) error { return search(args[0]) },`);
    assert.deepEqual(await signals(safe), [], literal);

    const guarded = command(`		RunE: func(_ *cobra.Command, args []string) error {
			if len(args) < ${literal} { return errors.New("missing") }
			return search(args[0])
		},`).replace(
      'import "github.com/spf13/cobra"',
      'import (\n\t"errors"\n\t"github.com/spf13/cobra"\n)',
    );
    assert.deepEqual(await signals(guarded), [], `guard ${literal}`);
  }
});

test("trusts len, append, and make only when their builtin bindings are unshadowed", async () => {
  const shadowedLen = command(`		RunE: func(_ *cobra.Command, args []string) error {
			len := func([]string) int { return 1 }
			if len(args) > 0 { return search(args[0]) }
			return nil
		},`);
  assert.equal((await signals(shadowedLen)).length, 1);

  const packageLen = shadowedLen
    .replace("\t\t\tlen := func([]string) int { return 1 }\n", "")
    .replace("func newSearchCommand", "func len([]string) int { return 1 }\n\nfunc newSearchCommand");
  assert.equal((await signals(packageLen)).length, 1);

  const shadowedAppend = command(`		RunE: func(_ *cobra.Command, args []string) error {
			append := func([]string, string) []string { return nil }
			args = append(args, "fallback")
			return search(args[0])
		},`);
  assert.equal((await signals(shadowedAppend)).length, 1);

  const shadowedMake = command(`		RunE: func(_ *cobra.Command, args []string) error {
			make := func([]string, int) []string { return nil }
			args = make([]string, 1)
			return search(args[0])
		},`);
  assert.equal((await signals(shadowedMake)).length, 1);

  const packageAppend = command(`		RunE: func(_ *cobra.Command, args []string) error {
			args = append(args, "fallback")
			return search(args[0])
		},`).replace(
    "func newSearchCommand",
    "func append([]string, string) []string { return nil }\n\nfunc newSearchCommand",
  );
  assert.equal((await signals(packageAppend)).length, 1);

  const nestedLen = command(`		RunE: func(_ *cobra.Command, args []string) error {
			func(len func([]string) int) {
				if len(args) > 0 { search(args[0]) }
			}(func([]string) int { return 1 })
			return nil
		},`);
  assert.equal((await signals(nestedLen)).length, 1);
});

test("derives slice literal minimum from numeric keyed indices", async () => {
  const keyed = command(`		RunE: func(_ *cobra.Command, args []string) error {
			args = []string{3: "fourth"}
			return search(args[3])
		},`);
  assert.deepEqual(await signals(keyed), []);

  const mixed = keyed.replace('[]string{3: "fourth"}', '[]string{"first", 3: "fourth", "fifth"}').replace("args[3]", "args[4]");
  assert.deepEqual(await signals(mixed), []);

  const keyedHex = keyed.replace("3:", "0x3:");
  assert.deepEqual(await signals(keyedHex), []);

  const unknown = keyed.replace("3:", "slot:");
  assert.equal((await signals(unknown)).length, 1);

  const keyedBinary = keyed.replace("3:", "0b_11:");
  assert.deepEqual(await signals(keyedBinary), []);
});

test("recognizes an exhaustive nested switch as a short-input exit", async () => {
  const safe = command(`		RunE: func(_ *cobra.Command, args []string) error {
			if len(args) == 0 {
				switch mode {
				case "strict": return errors.New("missing")
				default: panic("missing")
				}
			}
			return search(args[0])
		},`).replace(
    'import "github.com/spf13/cobra"',
    'import (\n\t"errors"\n\t"github.com/spf13/cobra"\n)',
  );
  assert.deepEqual(await signals(safe), []);

  const unsafe = safe.replace('\n\t\t\t\tdefault: panic("missing")', "");
  assert.equal((await signals(unsafe)).length, 1);
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
