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

function capturingModel(output: ModelCliReview): CapturingModel {
  const requests: ModelReviewRequest[] = [];
  return {
    requests,
    async review<T>(request: ModelReviewRequest) {
      requests.push(request);
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
  // Concern comes from observation title (noun phrase), not free-form primaryConcern.
  assert.match(result.opinion?.summary ?? "", /Commands discard inherited context/i);
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
  assert.match(result.opinion?.summary ?? "", /defer os\.Exit\(124\)/);
  assert.doesNotMatch(result.opinion?.summary ?? "", /overrides the normal exit-code path/i);
  assert.doesNotMatch(result.opinion?.summary ?? "", /exit 1/i);
  assert.doesNotMatch(result.opinion?.summary ?? "", /ship this as-is/i);
});
