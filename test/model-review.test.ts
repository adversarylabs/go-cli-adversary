import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  type ModelReviewRequest,
  type ReviewModel,
  type ReviewResult,
} from "@adversarylabs/sdk";
import { createApp } from "../src/index.ts";
import {
  GO_CLI_MODEL_PROMPT,
  GO_CLI_MODEL_SCHEMA,
  type ModelCliReview,
  prepareModelInputFromDiscovery,
} from "../src/model-review.ts";

type CapturingModel = ReviewModel & { requests: ModelReviewRequest[] };

function isConcernRewriteRequest(request: ModelReviewRequest): boolean {
  const schema = request.schema as {
    required?: string[];
    properties?: Record<string, unknown>;
  };
  return (
    Array.isArray(schema.required) &&
    schema.required.includes("concern") &&
    schema.properties !== undefined &&
    "concern" in schema.properties
  );
}

/** Deterministic noun phrases for concern-rewrite broker calls in tests. */
function fixtureConcernRewrite(text: string): string {
  if (/exit code 124|os\.Exit\(124\)/i.test(text)) return "forced exit code 124";
  if (/silently\s+no-?op|no-?op for v1/i.test(text)) return "silent no-op v1 paths";
  if (/discard|inherited context|cancellation/i.test(text)) {
    return "inherited context in command handlers";
  }
  if (/flag default|incompatib/i.test(text)) return "incompatible flag default changes";
  if (/stdout|stderr|progress mixed/i.test(text)) return "stdout and stderr contract violations";
  if (/incomplete|unfinished/i.test(text)) return "incomplete command implementation";
  return "incorrect command behavior";
}

function capturingModel(output: ModelCliReview): CapturingModel {
  const requests: ModelReviewRequest[] = [];
  return {
    requests,
    async review<T>(request: ModelReviewRequest) {
      requests.push(request);
      if (isConcernRewriteRequest(request)) {
        const text = String(
          (request.input as { text?: string } | undefined)?.text ?? "",
        );
        return {
          output: { concern: fixtureConcernRewrite(text) } as T,
          provider: "fixture",
          model: "go-cli-concern-rewrite",
        };
      }
      return {
        output: output as T,
        provider: "fixture",
        model: "go-cli-test",
      };
    },
  };
}

async function writeCliFixture(
  name: string,
  files: Record<string, string>,
): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), `go-cli-model-${name}-`));
  for (const [relative, content] of Object.entries(files)) {
    const absolute = join(root, relative);
    await mkdir(join(absolute, ".."), { recursive: true });
    await writeFile(absolute, content);
  }
  return root;
}

async function runWithModel(
  root: string,
  model: ReviewModel,
  change?: {
    base_ref: string;
    head_ref: string;
    scan_mode: "changed" | "all";
    changed_files: string[];
  },
): Promise<ReviewResult> {
  return createApp().run({
    model,
    input: {
      source: { path: root },
      ...(change === undefined
        ? {}
        : {
            change: {
              type: "diff",
              base_ref: change.base_ref,
              head_ref: change.head_ref,
              scan_mode: change.scan_mode,
              changed_files: change.changed_files,
            },
          }),
    },
  });
}

function assertBoundedGoCliRequest(request: ModelReviewRequest): void {
  assert.equal(request.prompt, GO_CLI_MODEL_PROMPT);
  assert.deepEqual(request.schema, GO_CLI_MODEL_SCHEMA);
  assert.equal(request.budget?.maximumOutputTokens, 4_096);
  assert.equal(request.budget?.timeoutMs, 120_000);

  const input = request.input as {
    domain: string;
    sources: Array<{ content: string; path: string }>;
    deterministicSignals: unknown[];
    evidenceCatalog: unknown[];
    change: { scanMode: string; changedFiles: string[] };
  };
  assert.equal(input.domain, "go-cli");
  assert.ok(Array.isArray(input.sources));
  assert.ok(input.sources.length <= 16);
  for (const source of input.sources) {
    assert.ok(source.content.length <= 6_000 + 32, `source too large: ${source.path}`);
  }
  assert.ok(input.deterministicSignals.length <= 40);
  assert.ok(input.evidenceCatalog.length >= input.sources.length);
  assert.ok(["changed", "all", "repository"].includes(input.change.scanMode));
}

test("well-designed CLI change: model returns no findings and keeps approve opinion", async () => {
  const root = await writeCliFixture("well-designed", {
    "cmd/root.go": `package main

import (
	"context"
	"os/exec"
)

type command struct{ ctx context.Context }

func (c command) Context() context.Context { return c.ctx }

func run(cmd command) error {
	return exec.CommandContext(cmd.Context(), "git", "status").Run()
}
`,
  });
  const model = capturingModel({
    assessment: {
      risk: "none",
      summary: "The command path preserves context and subprocess cancellation.",
    },
    ship: true,
    observations: [],
  });

  const result = await runWithModel(root, model, {
    base_ref: "main",
    head_ref: "HEAD",
    scan_mode: "changed",
    changed_files: ["cmd/root.go"],
  });

  assert.equal(model.requests.length, 1);
  assertBoundedGoCliRequest(model.requests[0]!);
  assert.equal(result.assessment?.risk, "none");
  assert.match(result.assessment?.summary ?? "", /preserves context/);
  assert.equal(result.opinion?.ship, true);
  assert.equal(
    result.observations.filter((note) => note.key.startsWith("go-cli.model.")).length,
    0,
  );
});

test("CLI compatibility regression: model flags flag/default contract issues", async () => {
  const root = await writeCliFixture("compat-regression", {
    "cmd/root.go": `package main

import "flag"

func parse() {
	// Default changed from false to true without a migration note.
	enabled := flag.Bool("enable-legacy", true, "enable legacy mode")
	_ = enabled
}
`,
  });
  const model = capturingModel({
    assessment: {
      risk: "high",
      summary: "A default flag change breaks existing automation.",
    },
    ship: false,
    primaryConcern: "incompatible flag default change",
    observations: [
      {
        id: "legacy-default",
        title: "Flag default changed incompatibly",
        category: "flags-args",
        severity: "high",
        confidence: "high",
        summary: "enable-legacy now defaults to true, which changes existing scripts.",
        whyItMatters: "CLI defaults are part of the automation contract.",
        recommendation: "Keep the previous default or require an explicit opt-in flag.",
        evidenceIds: ["file:cmd/root.go"],
      },
    ],
  });

  const result = await runWithModel(root, model, {
    base_ref: "main",
    head_ref: "HEAD",
    scan_mode: "changed",
    changed_files: ["cmd/root.go"],
  });

  assert.equal(model.requests.length, 1);
  assertBoundedGoCliRequest(model.requests[0]!);
  const modelNotes = result.observations.filter((note) => note.key.startsWith("go-cli.model."));
  assert.equal(modelNotes.length, 1);
  assert.match(modelNotes[0]!.summary, /Flag default changed incompatibly/);
  assert.equal(result.opinion?.ship, false);
  // Concern is derived from observation title, not primaryConcern prose.
  assert.match(result.opinion?.summary ?? "", /flag default changed incompatibly/i);
  assert.equal(modelNotes[0]!.evidence?.[0]?.location?.file, "cmd/root.go");
});

test("incompatible flag modes: model reports an explicitly supplied value bypassed by another mode", async () => {
  const root = await writeCliFixture("incompatible-flag-modes", {
    "pkg/cmd/items/list.go": `package items

import "github.com/spf13/cobra"

type listOptions struct {
	format string
	fields []string
}

func newListCommand() *cobra.Command {
	opts := listOptions{}
	cmd := &cobra.Command{
		Use: "list",
		RunE: func(cmd *cobra.Command, args []string) error { return runList(opts) },
	}
	cmd.Flags().StringVar(&opts.format, "output", "table", "output mode")
	cmd.Flags().StringSliceVar(&opts.fields, "select", nil, "fields to include")
	return cmd
}

func runList(opts listOptions) error {
	if opts.format == "json" {
		return encodeAllItems()
	}
	return renderTable(opts.fields)
}
`,
  });
  const model = capturingModel({
    assessment: {
      risk: "medium",
      summary: "Structured output silently ignores an explicitly supplied field selection.",
    },
    ship: false,
    primaryConcern: "silently ignored field selection",
    observations: [
      {
        id: "ignored-selection",
        title: "Structured output bypasses field selection",
        category: "flags-args",
        severity: "medium",
        confidence: "high",
        summary: "The command accepts output and select together, but the JSON branch never consumes select.",
        whyItMatters: "The command exits successfully after discarding explicit user intent.",
        recommendation: "Apply the selection before formatting or reject the combination before doing work.",
        evidenceIds: ["file:pkg/cmd/items/list.go"],
      },
    ],
  });

  const result = await runWithModel(root, model, {
    base_ref: "main",
    head_ref: "HEAD",
    scan_mode: "changed",
    changed_files: ["pkg/cmd/items/list.go"],
  });

  const request = model.requests.find((item) => !isConcernRewriteRequest(item));
  assert.ok(request, "expected the bounded CLI model review request");
  assertBoundedGoCliRequest(request);
  const input = request.input as {
    sources: Array<{ path: string; content: string }>;
  };
  const source = input.sources.find((item) => item.path === "pkg/cmd/items/list.go");
  assert.match(source?.content ?? "", /StringSliceVar/);
  assert.match(source?.content ?? "", /if opts\.format == "json"/);

  const note = result.observations.find(
    (item) => item.key === "go-cli.model.ignored-selection",
  );
  assert.ok(note);
  assert.equal(note.evidence?.[0]?.location?.file, "pkg/cmd/items/list.go");
  assert.equal(note.metadata?.category, "flags-args");
  assert.match(String(note.metadata?.recommendation ?? ""), /reject the combination/i);
  assert.equal(result.opinion?.ship, false);
});

test("composable flag modes: model stays quiet when selection is applied before formatting", async () => {
  const root = await writeCliFixture("composable-flag-modes", {
    "internal/cli/items/list.go": `package items

type listOptions struct {
	format string
	fields []string
}

func runList(opts listOptions) error {
	selected := selectFields(loadItems(), opts.fields)
	if opts.format == "json" {
		return encodeItems(selected)
	}
	return renderTable(selected)
}
`,
  });
  const model = capturingModel({
    assessment: {
      risk: "none",
      summary: "Field selection is applied before either output renderer.",
    },
    ship: true,
    observations: [],
  });

  const result = await runWithModel(root, model, {
    base_ref: "main",
    head_ref: "HEAD",
    scan_mode: "changed",
    changed_files: ["internal/cli/items/list.go"],
  });

  assert.equal(result.opinion?.ship, true);
  assert.equal(
    result.observations.filter((item) => item.key.startsWith("go-cli.model.")).length,
    0,
  );
});

test("incomplete command implementation: model reports unfinished paths", async () => {
  const root = await writeCliFixture("incomplete-command", {
    "cmd/cluster.go": `package main

func newClusterCmd() {
	// TODO: wire RunE and validate required flags before calling the API.
}
`,
  });
  const model = capturingModel({
    assessment: {
      risk: "medium",
      summary: "The cluster command is incomplete and cannot be automated safely.",
    },
    ship: false,
    primaryConcern: "incomplete command implementation",
    observations: [
      {
        id: "cluster-incomplete",
        title: "Cluster command is not wired",
        category: "completeness",
        severity: "medium",
        confidence: "high",
        summary: "newClusterCmd does not attach RunE or required-flag validation.",
        whyItMatters: "Users and scripts cannot rely on a registered but unfinished command.",
        recommendation: "Implement RunE, validate flags before side effects, and add a test.",
        evidenceIds: ["file:cmd/cluster.go"],
      },
    ],
  });

  const result = await runWithModel(root, model);
  const note = result.observations.find((item) => item.key === "go-cli.model.cluster-incomplete");
  assert.ok(note);
  assert.match(note.summary, /Cluster command is not wired/);
  assert.equal(result.assessment?.risk, "medium");
});

test("incorrect stdout/stderr or exit behavior: model captures stream contract issues", async () => {
  const root = await writeCliFixture("stream-contract", {
    "cmd/print.go": `package main

import "fmt"

func run() {
	fmt.Printf("progress: loading\\n")
	fmt.Printf("{\\"ok\\":true}\\n")
}
`,
  });
  const model = capturingModel({
    assessment: {
      risk: "high",
      summary: "Progress and machine output share stdout, breaking pipelines.",
    },
    ship: false,
    primaryConcern: "stdout/stderr contract violation",
    observations: [
      {
        id: "stdout-mix",
        title: "Progress mixed with JSON on stdout",
        category: "stdout-stderr",
        severity: "high",
        confidence: "high",
        summary: "Human progress and JSON payload are both written to stdout.",
        whyItMatters: "Scripts piping to jq will fail when progress lines interleave.",
        recommendation: "Send progress to stderr and reserve stdout for the JSON document.",
        evidenceIds: ["file:cmd/print.go"],
      },
    ],
  });

  const result = await runWithModel(root, model, {
    base_ref: "main",
    head_ref: "HEAD",
    scan_mode: "changed",
    changed_files: ["cmd/print.go"],
  });
  assert.equal(result.opinion?.ship, false);
  assert.ok(result.observations.some((note) => note.key === "go-cli.model.stdout-mix"));
  assert.match(result.assessment?.summary ?? "", /stdout/);
});

test("model response with no findings does not invent observations", async () => {
  const root = await writeCliFixture("no-findings", {
    "cmd/ok.go": `package main

func run() error { return nil }
`,
  });
  const model = capturingModel({
    assessment: { risk: "none", summary: "No CLI contract issues found in the prepared change." },
    ship: true,
    observations: [],
  });
  const result = await runWithModel(root, model);
  assert.equal(result.opinion?.ship, true);
  assert.equal(
    result.observations.filter((note) => note.key.startsWith("go-cli.model.")).length,
    0,
  );
  assert.equal(model.requests[0]!.input && (model.requests[0]!.input as { domain: string }).domain, "go-cli");
});

test("model observations with only unknown evidence IDs are dropped", async () => {
  const root = await writeCliFixture("unknown-evidence", {
    "cmd/ok.go": `package main

func run() error { return nil }
`,
  });
  const model = capturingModel({
    assessment: { risk: "none", summary: "The prepared change is safe." },
    ship: true,
    primaryConcern: "fabricated incompatible flags",
    observations: [
      {
        id: "fabricated-citation",
        title: "Fabricated incompatible flags",
        category: "flags-args",
        severity: "high",
        confidence: "high",
        summary: "This observation cites no prepared source.",
        whyItMatters: "Unsupported observations must not reach users.",
        recommendation: "Drop observations without validated evidence.",
        evidenceIds: ["file:cmd/not-in-input.go"],
      },
    ],
  });

  const result = await runWithModel(root, model, {
    base_ref: "main",
    head_ref: "HEAD",
    scan_mode: "changed",
    changed_files: ["cmd/ok.go"],
  });

  assert.equal(
    result.observations.some(
      (note) => note.key === "go-cli.model.fabricated-citation",
    ),
    false,
  );
  assert.equal(result.assessment?.risk, "none");
  assert.equal(result.opinion?.ship, true);
  assert.doesNotMatch(result.opinion?.summary ?? "", /fabricated incompatible flags/i);
});

test("model observations keep only validated evidence IDs", async () => {
  const root = await writeCliFixture("mixed-evidence", {
    "cmd/root.go": `package main

func run() error { return nil }
`,
  });
  const model = capturingModel({
    assessment: { risk: "medium", summary: "A CLI contract needs attention." },
    ship: false,
    observations: [
      {
        id: "mixed-citations",
        title: "Incompatible output flags",
        category: "flags-args",
        severity: "medium",
        confidence: "high",
        summary: "The observation includes one prepared source citation.",
        whyItMatters: "Only validated evidence should be shown to users.",
        recommendation: "Retain the prepared source and discard unknown citations.",
        evidenceIds: [
          "file:cmd/not-in-input.go",
          "file:cmd/root.go",
          "file:cmd/also-missing.go",
        ],
      },
    ],
  });

  const result = await runWithModel(root, model, {
    base_ref: "main",
    head_ref: "HEAD",
    scan_mode: "changed",
    changed_files: ["cmd/root.go"],
  });

  const note = result.observations.find(
    (item) => item.key === "go-cli.model.mixed-citations",
  );
  assert.ok(note);
  assert.deepEqual(
    note.evidence?.map((item) => item.location?.file),
    ["cmd/root.go"],
  );
  assert.deepEqual(note.metadata?.evidenceIds, ["file:cmd/root.go"]);
});

test("prepared model input stays bounded and includes change plus deterministic evidence", () => {
  const prepared = prepareModelInputFromDiscovery(
    {
      scanMode: "changed",
      baseRef: "main",
      headRef: "HEAD",
      worktree: false,
      changedFiles: ["cmd/root.go"],
      type: "diff",
    },
    {
      mode: "diff",
      base: "main",
      filesScanned: 1,
      signals: [
        {
          ruleId: "go-cli.exit-bypass",
          path: "cmd/root.go",
          line: 10,
          message: "terminates",
          snippet: "os.Exit(1)",
          data: {},
        },
      ],
      positives: [],
      parseErrors: [],
    },
    [
      {
        path: "cmd/root.go",
        status: "modified",
        current: `${"package main\n"}${"// pad\n".repeat(2_000)}func main() { os.Exit(1) }\n`,
      },
    ],
  );

  assert.equal(prepared.domain, "go-cli");
  assert.equal(prepared.change.scanMode, "changed");
  assert.deepEqual(prepared.change.changedFiles, ["cmd/root.go"]);
  assert.equal(prepared.deterministicSignals.length, 1);
  assert.equal(prepared.sources.length, 1);
  assert.equal(prepared.sources[0]!.truncated, true);
  assert.ok(prepared.sources[0]!.content.includes("truncated"));
  assert.ok(prepared.evidenceCatalog.some((item) => item.id.startsWith("det:")));
  assert.ok(prepared.evidenceCatalog.some((item) => item.id === "file:cmd/root.go"));
});

test("without an injected model the deterministic path still runs", async () => {
  const root = await writeCliFixture("deterministic-only", {
    "main.go": `package main

import "os"

func main() { os.Exit(1) }
`,
  });
  const result = await createApp().run({ input: { source: { path: root } } });
  assert.ok((result.findings?.length ?? 0) >= 1 || result.assessment !== undefined);
  assert.equal(
    result.observations.filter((note) => note.key.startsWith("go-cli.model.")).length,
    0,
  );
});

test("model ship:true is overridden when static high findings exist", async () => {
  const root = await writeCliFixture("ship-override-static", {
    "cmd/root.go": `package main

import "os"

func run() {
	os.Exit(1)
}
`,
  });
  const model = capturingModel({
    assessment: {
      risk: "medium",
      summary: "Cancellation is the main issue, but the model optimistically ships.",
    },
    ship: true,
    primaryConcern:
      "cancellation is broken across most commands: context.Background()/context.TODO() replaces the signal-aware context, so Ctrl+C cannot interrupt network calls or subprocesses",
    observations: [
      {
        id: "cancel-story",
        title: "Commands discard inherited context",
        category: "cancellation",
        severity: "medium",
        confidence: "high",
        summary: "RunE handlers use context.Background instead of cmd.Context().",
        whyItMatters: "Ctrl+C does not stop API calls.",
        recommendation: "Thread cmd.Context() through handlers.",
        evidenceIds: ["file:cmd/root.go"],
      },
    ],
  });

  const result = await runWithModel(root, model);
  assert.equal(result.opinion?.ship, false, "blocking static/model work must not ship");
  assert.equal(result.assessment?.risk, "high", "risk must be max(static high, model)");
  assert.match(result.opinion?.summary ?? "", /before shipping|before merging|before committing/i);
  assert.doesNotMatch(result.opinion?.summary ?? "", /ship this as-is/i);
  // Static high (os.Exit) outranks model medium: opinion follows the risk driver.
  assert.match(
    result.opinion?.summary ?? "",
    /I would address direct process termination below the application boundary/i,
  );
  assert.doesNotMatch(
    result.opinion?.summary ?? "",
    /cancellation is broken across most commands/i,
  );
});

test("model ship:true is overridden by medium model observations alone", async () => {
  const root = await writeCliFixture("ship-override-model", {
    "cmd/ok.go": `package main

func run() error { return nil }
`,
  });
  const model = capturingModel({
    assessment: {
      risk: "low",
      summary: "One CLI contract issue remains.",
    },
    ship: true,
    primaryConcern: "stdout/stderr contract violation",
    observations: [
      {
        id: "streams",
        title: "Progress mixed with JSON on stdout",
        category: "stdout-stderr",
        severity: "medium",
        confidence: "high",
        summary: "Human progress and JSON share stdout.",
        whyItMatters: "Pipelines break.",
        recommendation: "Send progress to stderr.",
        evidenceIds: ["file:cmd/ok.go"],
      },
    ],
  });

  const result = await runWithModel(root, model);
  assert.equal(result.opinion?.ship, false);
  assert.equal(result.assessment?.risk, "medium");
  assert.doesNotMatch(result.opinion?.summary ?? "", /ship this as-is/i);
});

test("opinion concern uses observation title noun phrase, not primaryConcern prose", async () => {
  const root = await writeCliFixture("concern-title", {
    "cmd/root.go": `package main

func run() error { return nil }
`,
  });
  const model = capturingModel({
    assessment: {
      risk: "high",
      summary: "Exit-code contract is broken by deferred process termination.",
    },
    ship: false,
    primaryConcern:
      "defer os.Exit(124) in multiple commands overrides the normal exit-code path, causing successful invocations to exit 1",
    observations: [
      {
        id: "exit-124",
        title: "defer os.Exit(124) forces exit code 124 regardless of command success",
        category: "exit-codes",
        severity: "high",
        confidence: "high",
        summary: "Deferred os.Exit(124) always runs and yields timeout exit code 124.",
        whyItMatters: "Scripts misinterpret success as timeout.",
        recommendation: "Return errors and map exit codes once in main.",
        evidenceIds: ["file:cmd/root.go"],
      },
    ],
  });

  const result = await runWithModel(root, model);
  assert.equal(result.opinion?.ship, false);
  // Title rewritten via ctx.model.concern (SDK → broker) into a noun phrase.
  assert.match(result.opinion?.summary ?? "", /I would address forced exit code 124/i);
  assert.doesNotMatch(result.opinion?.summary ?? "", /overrides the normal exit-code path/i);
  assert.doesNotMatch(result.opinion?.summary ?? "", /exit 1/i);
  assert.doesNotMatch(result.opinion?.summary ?? "", /ship this as-is/i);
  assert.ok(
    model.requests.some((request) => isConcernRewriteRequest(request)),
    "invalid titles should trigger a concern rewrite model call",
  );
});

test("opinion rewrites silent no-op headlines via model.concern", async () => {
  const root = await writeCliFixture("silent-noop-title", {
    "cmd/api.go": `package main

func run() error { return nil }
`,
  });
  const model = capturingModel({
    assessment: {
      risk: "medium",
      summary: "The api verb silently no-ops for v1 paths.",
    },
    ship: false,
    primaryConcern: "api get/post/patch/put silently no-op for v1 paths",
    observations: [
      {
        id: "api-v1",
        title: "api get/post/patch/put silently no-op for v1 paths",
        category: "command-behavior",
        severity: "medium",
        confidence: "high",
        summary: "The v1 branch is empty so requests exit 0 with no output.",
        whyItMatters: "Callers think the API call succeeded.",
        recommendation: "Implement v1 or return a clear unsupported-path error.",
        evidenceIds: ["file:cmd/api.go"],
      },
    ],
  });

  const result = await runWithModel(root, model);
  assert.equal(result.opinion?.ship, false);
  assert.match(result.opinion?.summary ?? "", /I would address silent no-op v1 paths/i);
  assert.doesNotMatch(result.opinion?.summary ?? "", /get\/post\/patch\/put/i);
  assert.doesNotMatch(result.opinion?.summary ?? "", /ship this as-is/i);
  assert.ok(model.requests.some((request) => isConcernRewriteRequest(request)));
});

test("wave B: model prompt prioritizes contract stories and schema allows new categories", () => {
  assert.match(GO_CLI_MODEL_PROMPT, /Silent success/);
  assert.match(GO_CLI_MODEL_PROMPT, /both options are accepted by the same command/);
  assert.match(GO_CLI_MODEL_PROMPT, /Do not infer a conflict from two flag declarations alone/);
  assert.match(GO_CLI_MODEL_PROMPT, /options are independent and legitimately compose/);
  assert.match(GO_CLI_MODEL_PROMPT, /Dry-run/);
  assert.match(GO_CLI_MODEL_PROMPT, /JSON \/ machine-output contract skew/);
  assert.match(GO_CLI_MODEL_PROMPT, /Provisional configuration outside an existing experimental boundary/);
  assert.match(GO_CLI_MODEL_PROMPT, /Incomplete configuration across a runtime operation family/);
  assert.match(GO_CLI_MODEL_PROMPT, /Do not equate novelty with experimental status/);
  assert.match(GO_CLI_MODEL_PROMPT, /Do not infer a family from naming similarity alone/);
  assert.match(GO_CLI_MODEL_PROMPT, /aggregate, inherited, or separate configuration path/);
  assert.match(GO_CLI_MODEL_PROMPT, /Do NOT restate static lifecycle hits/);
  const categories = (
    GO_CLI_MODEL_SCHEMA as {
      properties: { observations: { items: { properties: { category: { enum: string[] } } } } };
    }
  ).properties.observations.items.properties.category.enum;
  for (const needed of ["json-contract", "deprecation", "validation-order", "dry-run"]) {
    assert.ok(categories.includes(needed), `missing category ${needed}`);
  }
});

test("SPIRE-shaped configuration change exposes provisional placement and family completeness evidence", async () => {
  const root = await writeCliFixture("spire-config-contract", {
    "cmd/spire-agent/cli/run/run.go": `package run

type workloadAPIRateLimitConfig struct {
	FetchX509SVID *int \`hcl:"fetch_x509_svid"\`
	FetchJWTSVID  *int \`hcl:"fetch_jwt_svid"\`
}

type experimentalConfig struct {
	NamedPipeName string \`hcl:"named_pipe_name"\`
}

type agentConfig struct {
	RateLimit    workloadAPIRateLimitConfig \`hcl:"ratelimit"\`
	Experimental experimentalConfig         \`hcl:"experimental"\`
}

// Workload API rate limiting is experimental and its configuration may change
// after operator feedback before a targeted promotion in a later release.
func NewAgentConfig(c agentConfig) WorkloadAPIRateLimitConfig {
	return WorkloadAPIRateLimitConfig{
		FetchX509SVID: intVal(c.RateLimit.FetchX509SVID),
		FetchJWTSVID:  intVal(c.RateLimit.FetchJWTSVID),
	}
}
`,
    "pkg/agent/endpoints/ratelimit.go": `package endpoints

type WorkloadAPIRateLimitConfig struct {
	FetchX509SVID    int
	FetchJWTSVID     int
	FetchX509Bundles int
	FetchJWTBundles  int
	StreamSecrets    int
	FetchSecrets     int
}

func NewWorkloadRateLimiter(c WorkloadAPIRateLimitConfig) *RateLimiter {
	r := newRateLimiter()
	r.method("FetchX509SVID", c.FetchX509SVID)
	r.method("FetchJWTSVID", c.FetchJWTSVID)
	r.method("FetchX509Bundles", c.FetchX509Bundles)
	r.method("FetchJWTBundles", c.FetchJWTBundles)
	r.method("StreamSecrets", c.StreamSecrets)
	r.method("FetchSecrets", c.FetchSecrets)
	return r
}
`,
  });
  const model = capturingModel({
    assessment: {
      risk: "medium",
      summary: "The provisional rate-limit contract is stable-facing and incomplete across supported Workload API operations.",
    },
    ship: false,
    primaryConcern: "incomplete provisional rate-limit configuration",
    observations: [
      {
        id: "experimental-placement",
        title: "Experimental rate limit in stable configuration",
        category: "configuration",
        severity: "medium",
        confidence: "high",
        summary: "RateLimit is explicitly experimental but is introduced beside the existing Experimental block.",
        whyItMatters: "Users may treat a feedback-driven configuration shape as a stable compatibility contract.",
        recommendation: "Nest RateLimit under Experimental until its configuration contract is ready for promotion.",
        evidenceIds: [
          "file:cmd/spire-agent/cli/run/run.go",
          "file:pkg/agent/endpoints/ratelimit.go",
        ],
      },
      {
        id: "operation-family",
        title: "Bundle and secret rate limits are not configurable",
        category: "completeness",
        severity: "medium",
        confidence: "high",
        summary: "The same rate-limit mechanism covers six Workload API operations, but configuration exposes only the two SVID operations.",
        whyItMatters: "Operators cannot tune equivalent supported bundle and secret operations.",
        recommendation: "Expose settings for the four proven sibling operations or document their distinct policy boundary.",
        evidenceIds: ["file:cmd/spire-agent/cli/run/run.go"],
      },
    ],
  });

  const result = await runWithModel(root, model, {
    base_ref: "main",
    head_ref: "HEAD",
    scan_mode: "changed",
    changed_files: [
      "cmd/spire-agent/cli/run/run.go",
      "pkg/agent/endpoints/ratelimit.go",
    ],
  });

  const request = model.requests.find((item) => !isConcernRewriteRequest(item));
  assert.ok(request);
  assertBoundedGoCliRequest(request);
  const prepared = request.input as { sources: Array<{ path: string; content: string }> };
  const source = prepared.sources.find((item) => item.path === "cmd/spire-agent/cli/run/run.go");
  assert.match(source?.content ?? "", /Experimental experimentalConfig/);
  assert.match(source?.content ?? "", /configuration may change/);
  const runtime = prepared.sources.find(
    (item) => item.path === "pkg/agent/endpoints/ratelimit.go",
  );
  assert.match(runtime?.content ?? "", /FetchX509Bundles/);
  assert.match(runtime?.content ?? "", /FetchSecrets/);
  assert.deepEqual(
    result.observations
      .filter((item) => item.key.startsWith("go-cli.model."))
      .map((item) => item.metadata?.category)
      .sort(),
    ["completeness", "configuration"],
  );
  assert.equal(result.opinion?.ship, false);
});

test("accepted SPIRE-shaped configuration nests the complete operation family and stays quiet", async () => {
  const root = await writeCliFixture("spire-config-contract-clean", {
    "cmd/spire-agent/cli/run/run.go": `package run

type workloadAPIRateLimitConfig struct {
	FetchX509SVID    *int \`hcl:"fetch_x509_svid"\`
	FetchJWTSVID     *int \`hcl:"fetch_jwt_svid"\`
	FetchX509Bundles *int \`hcl:"fetch_x509_bundles"\`
	FetchJWTBundles  *int \`hcl:"fetch_jwt_bundles"\`
	StreamSecrets    *int \`hcl:"stream_secrets"\`
	FetchSecrets     *int \`hcl:"fetch_secrets"\`
}

type experimentalConfig struct {
	RateLimit workloadAPIRateLimitConfig \`hcl:"ratelimit"\`
}

type agentConfig struct {
	Experimental experimentalConfig \`hcl:"experimental"\`
}

func NewAgentConfig(c agentConfig) WorkloadAPIRateLimitConfig {
	r := c.Experimental.RateLimit
	return WorkloadAPIRateLimitConfig{
		FetchX509SVID:    intVal(r.FetchX509SVID),
		FetchJWTSVID:     intVal(r.FetchJWTSVID),
		FetchX509Bundles: intVal(r.FetchX509Bundles),
		FetchJWTBundles:  intVal(r.FetchJWTBundles),
		StreamSecrets:    intVal(r.StreamSecrets),
		FetchSecrets:     intVal(r.FetchSecrets),
	}
}
`,
    "pkg/agent/endpoints/ratelimit.go": `package endpoints

type WorkloadAPIRateLimitConfig struct {
	FetchX509SVID    int
	FetchJWTSVID     int
	FetchX509Bundles int
	FetchJWTBundles  int
	StreamSecrets    int
	FetchSecrets     int
}
`,
  });
  const model = capturingModel({
    assessment: {
      risk: "none",
      summary: "The provisional configuration is isolated and covers every proven operation in the runtime family.",
    },
    ship: true,
    observations: [],
  });

  const result = await runWithModel(root, model, {
    base_ref: "main",
    head_ref: "HEAD",
    scan_mode: "changed",
    changed_files: [
      "cmd/spire-agent/cli/run/run.go",
      "pkg/agent/endpoints/ratelimit.go",
    ],
  });
  assert.equal(result.opinion?.ship, true);
  assert.equal(
    result.observations.filter((item) => item.key.startsWith("go-cli.model.")).length,
    0,
  );
});

test("wave B: json-contract observation is accepted and framed in opinion when primary", async () => {
  const root = await writeCliFixture("wave-b-json", {
    "cmd/list.go": `package cmd
func run() error { return nil }
`,
  });
  const model = capturingModel({
    assessment: {
      risk: "medium",
      summary: "Store subcommands emit raw JSON while list uses a versioned envelope.",
    },
    ship: false,
    primaryConcern: "inconsistent machine-readable output contracts",
    observations: [
      {
        id: "json-skew",
        title: "store vs list JSON envelope skew",
        category: "json-contract",
        severity: "medium",
        confidence: "high",
        summary: "store check encodes raw DTOs; list wraps schemaVersion.",
        whyItMatters: "Scripts parsing one shape break on the other command family.",
        recommendation: "Use one versioned envelope for all machine output.",
        evidenceIds: ["file:cmd/list.go"],
      },
    ],
  });
  const result = await runWithModel(root, model);
  assert.equal(result.opinion?.ship, false);
  assert.match(result.opinion?.summary ?? "", /inconsistent machine-readable output contracts|json/i);
  assert.ok(
    result.observations.some((n) => n.key?.includes("json-skew") || (n.summary ?? "").includes("JSON")),
  );
});
