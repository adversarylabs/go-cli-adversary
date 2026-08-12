import {
  formatOpinion,
  isOpinionConcernPhrase,
  ModelUnavailableError,
  ModelReviewError,
  requireOpinionConcern,
  type ChangeContext,
  type ModelReviewRequest,
  type RuleContext,
} from "@adversarylabs/sdk";
import { pathPriority } from "./paths.js";
import { type Analysis, type Signal } from "./types.js";

const MAX_MODEL_FILES = 16;
const MAX_FILE_CHARS = 6_000;
const MAX_DETERMINISTIC_SIGNALS = 40;
const MAX_MODEL_OBSERVATIONS = 8;

export const GO_CLI_MODEL_PROMPT = `You are reviewing a Go command-line application change for CLI contract quality.

Focus only on Go CLI engineering that affects users of the CLI:
- command and subcommand behavior
- flags, arguments, defaults, and precedence
- exit codes and stdout/stderr contracts
- interactive versus non-interactive behavior
- cancellation and signal handling
- configuration compatibility
- error behavior and actionable diagnostics
- scripting and automation compatibility
- completion of related CLI code paths

Prioritize these high-value contract stories when evidence supports them (prefer novel insights over restating deterministic signals already listed):
1. Validation after side effects — network/write/process launch before flag/arg validation fails.
2. Silent success / no-op paths — empty branches, stub handlers, or missing cases that still return nil / exit 0.
3. Incompatible flag or mode interactions — the command accepts both explicitly supplied options, but one mode branch bypasses or ignores the other option's value without an early error or normalization.
4. Dry-run / apply / force flag interactions that silently ignore user intent.
5. JSON / machine-output contract skew — raw Encode vs versioned envelope; deprecated flags emitting different schemas than replacements (--json vs --format json).
6. Success exit when the primary action failed, or exit-code conventions that break automation.
7. User-facing timeouts/flags not wired into contexts used for network or child work.
8. Broad process kills (pkill -f) and forced destructive infra commands without dry-run/confirm.
9. Long-running children (port-forward/tunnel) started without PID ownership or stop path.

For incompatible flags or modes, report only when the prepared source proves all of these:
- both options are accepted by the same command and can be explicitly supplied together;
- a mode branch, early return, or alternate renderer leaves the other supplied value unused;
- no parse-time or early handler guard rejects or canonicalizes the combination.
Do not infer a conflict from two flag declarations alone. Stay quiet when both values are applied, when aliases share one underlying value, or when options are independent and legitimately compose. Recommend either honoring both explicit values or rejecting the combination before side effects.

Do NOT review generic Go style, broad security, observability, databases, or general engineering quality unless it directly breaks the CLI contract.
Do NOT restate static lifecycle hits (os.Exit, exec.Command without context, context.Background in handlers) unless you add a user-impact angle the static title misses.

Use only the prepared evidence and source excerpts. Cite evidence with the provided evidence IDs.
Return a small number of high-confidence observations (zero is valid). Prefer severity that matches user impact.

For each observation.title use a short headline. Prefer noun phrases when possible.
If you set primaryConcern, it must be a short noun phrase suitable after \"I would address …\"
(for example \"forced exit code 124\" or \"silent no-op v1 paths\"), never a full sentence,
clause, or slash-separated method list.
When category is json-contract or deprecation, name the concrete flag or command family in the title.`;

/** Strict, provider-compatible JSON Schema for structured Go CLI model output. */
export const GO_CLI_MODEL_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["assessment", "ship", "observations"],
  properties: {
    assessment: {
      type: "object",
      additionalProperties: false,
      required: ["risk", "summary"],
      properties: {
        risk: {
          type: "string",
          enum: ["none", "low", "medium", "high", "critical"],
        },
        summary: { type: "string", minLength: 1, maxLength: 800 },
      },
    },
    ship: { type: "boolean" },
    primaryConcern: { type: "string", minLength: 1, maxLength: 120 },
    observations: {
      type: "array",
      maxItems: MAX_MODEL_OBSERVATIONS,
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "id",
          "title",
          "category",
          "severity",
          "confidence",
          "summary",
          "whyItMatters",
          "recommendation",
          "evidenceIds",
        ],
        properties: {
          id: { type: "string", minLength: 1, maxLength: 64 },
          title: { type: "string", minLength: 1, maxLength: 160 },
          category: {
            type: "string",
            enum: [
              "command-behavior",
              "flags-args",
              "exit-codes",
              "stdout-stderr",
              "interactive",
              "cancellation",
              "configuration",
              "errors",
              "automation",
              "completeness",
              "json-contract",
              "deprecation",
              "validation-order",
              "dry-run",
              "process-ownership",
              "destructive-ops",
            ],
          },
          severity: {
            type: "string",
            enum: ["low", "medium", "high", "critical"],
          },
          confidence: {
            type: "string",
            enum: ["medium", "high"],
          },
          summary: { type: "string", minLength: 1, maxLength: 500 },
          whyItMatters: { type: "string", minLength: 1, maxLength: 500 },
          recommendation: { type: "string", minLength: 1, maxLength: 500 },
          evidenceIds: {
            type: "array",
            minItems: 1,
            maxItems: 8,
            items: { type: "string", minLength: 1, maxLength: 96 },
          },
        },
      },
    },
  },
};

export interface PreparedEvidenceItem {
  id: string;
  kind: "deterministic" | "source";
  path: string;
  line?: number;
  message: string;
  snippet: string;
}

export interface PreparedModelInput {
  domain: "go-cli";
  change: {
    scanMode: "changed" | "all" | "repository";
    baseRef?: string;
    headRef?: string;
    worktree?: boolean;
    changedFiles: string[];
  };
  deterministicSignals: Array<{
    id: string;
    ruleId: string;
    path: string;
    line: number;
    message: string;
    snippet: string;
  }>;
  sources: Array<{
    id: string;
    path: string;
    status: string;
    content: string;
    truncated: boolean;
  }>;
  evidenceCatalog: PreparedEvidenceItem[];
}

export interface ModelCliObservation {
  id: string;
  title: string;
  category: string;
  severity: "low" | "medium" | "high" | "critical";
  confidence: "medium" | "high";
  summary: string;
  whyItMatters: string;
  recommendation: string;
  evidenceIds: string[];
}

export interface ModelCliReview {
  assessment: {
    risk: "none" | "low" | "medium" | "high" | "critical";
    summary: string;
  };
  ship: boolean;
  primaryConcern?: string;
  observations: ModelCliObservation[];
}

export type DiscoveryFile = { path: string; current: string; status: string };

/** Build bounded model input from change, analysis signals, and discovered source bodies. */
export function prepareModelInputFromDiscovery(
  change: ChangeContext | null,
  analysis: Analysis,
  files: DiscoveryFile[],
): PreparedModelInput {
  const evidenceCatalog: PreparedEvidenceItem[] = [];
  const deterministicSignals = analysis.signals
    .slice()
    .sort(
      (left, right) =>
        left.path.localeCompare(right.path) ||
        left.line - right.line ||
        left.ruleId.localeCompare(right.ruleId),
    )
    .slice(0, MAX_DETERMINISTIC_SIGNALS)
    .map((signal) => {
      const id = evidenceIdForSignal(signal);
      evidenceCatalog.push({
        id,
        kind: "deterministic",
        path: signal.path,
        line: signal.line,
        message: signal.message,
        snippet: signal.snippet.slice(0, 300),
      });
      return {
        id,
        ruleId: signal.ruleId,
        path: signal.path,
        line: signal.line,
        message: signal.message,
        snippet: signal.snippet.slice(0, 300),
      };
    });

  const byPath = new Map(files.map((file) => [file.path, file]));
  const pathOrder = prioritizePaths(
    [
      ...analysis.signals.map((signal) => signal.path),
      ...(change?.changedFiles ?? []),
      ...files.map((file) => file.path),
    ],
    change?.changedFiles ?? [],
  );

  const sources: PreparedModelInput["sources"] = [];
  for (const path of pathOrder) {
    if (sources.length >= MAX_MODEL_FILES) break;
    const file = byPath.get(path);
    if (file === undefined) continue;
    const truncated = file.current.length > MAX_FILE_CHARS;
    const content = truncated
      ? `${file.current.slice(0, MAX_FILE_CHARS)}\n/* truncated */\n`
      : file.current;
    const id = `file:${path}`;
    sources.push({
      id,
      path,
      status: file.status,
      content,
      truncated,
    });
    evidenceCatalog.push({
      id,
      kind: "source",
      path,
      message: `Prepared source excerpt for ${path}`,
      snippet: content.split("\n").slice(0, 3).join("\n").slice(0, 300),
    });
  }

  return {
    domain: "go-cli",
    change: {
      scanMode: change === null ? "repository" : change.scanMode,
      ...(change?.baseRef === undefined ? {} : { baseRef: change.baseRef }),
      ...(change?.headRef === undefined ? {} : { headRef: change.headRef }),
      ...(change === null ? {} : { worktree: change.worktree }),
      changedFiles: [...(change?.changedFiles ?? [])].slice(0, 100),
    },
    deterministicSignals,
    sources,
    evidenceCatalog,
  };
}

export function buildModelReviewRequestFromDiscovery(
  change: ChangeContext | null,
  analysis: Analysis,
  files: DiscoveryFile[],
): {
  request: ModelReviewRequest;
  evidenceById: Map<string, PreparedEvidenceItem>;
  input: PreparedModelInput;
} {
  const input = prepareModelInputFromDiscovery(change, analysis, files);
  const evidenceById = new Map(input.evidenceCatalog.map((item) => [item.id, item]));
  return {
    input,
    evidenceById,
    request: {
      prompt: GO_CLI_MODEL_PROMPT,
      input,
      schema: GO_CLI_MODEL_SCHEMA,
      budget: {
        maximumOutputTokens: 4_096,
        timeoutMs: 120_000,
      },
    },
  };
}

export type StaticSeverity = "none" | "low" | "medium" | "high" | "critical";

export async function applyModelCliReview(
  ctx: RuleContext,
  output: ModelCliReview,
  evidenceById: Map<string, PreparedEvidenceItem>,
  staticSeverities: StaticSeverity[] = [],
  staticPrimaryConcern?: string,
): Promise<void> {
  const observations = output.observations
    .slice(0, MAX_MODEL_OBSERVATIONS)
    .map((observation) => ({
      ...observation,
      evidenceIds: [
        ...new Set(observation.evidenceIds.filter((id) => evidenceById.has(id))),
      ].slice(0, 8),
    }))
    .filter((observation) => observation.evidenceIds.length > 0);
  const modelObservationSeverities = observations.map((item) => item.severity);
  const risk = maxSeverity([
    output.assessment.risk,
    ...staticSeverities,
    ...modelObservationSeverities,
  ]);

  ctx.review.assessment({
    risk,
    summary: output.assessment.summary,
  });

  const rankedObservations = observations.slice().sort(
    (left, right) =>
      severityRank(right.severity) - severityRank(left.severity) || left.id.localeCompare(right.id),
  );
  // Never advertise ship-as-is when static or model work still shows material issues.
  const blocking =
    staticSeverities.some((severity) => severityRank(severity) >= severityRank("medium")) ||
    modelObservationSeverities.some((severity) => severityRank(severity) >= severityRank("medium"));
  const ship = output.ship && !blocking;

  // Prefer the severest story so risk/opinion stay coherent. Free-form model titles are
  // rewritten to noun phrases via ctx.model.concern (SDK → CLI broker).
  const topModel = rankedObservations[0];
  const staticMax = maxSeverity(staticSeverities);
  const modelMax = maxSeverity(modelObservationSeverities);
  const modelCandidates =
    topModel === undefined
      ? []
      : [topModel.title, output.primaryConcern, categoryConcern(topModel.category)];
  const staticCandidates = [staticPrimaryConcern];
  const ordered =
    severityRank(staticMax) > severityRank(modelMax)
      ? [...staticCandidates, ...modelCandidates]
      : [...modelCandidates, ...staticCandidates];
  const concern = await resolveOpinionConcern(ctx, ordered);

  ctx.review.opinion(
    formatOpinion({
      ship,
      ...(concern === undefined ? {} : { concern }),
      change: ctx.change,
    }),
  );

  for (const observation of observations) {
    const evidence = observation.evidenceIds
      .map((id) => evidenceById.get(id))
      .filter((item): item is PreparedEvidenceItem => item !== undefined)
      .slice(0, 8)
      .map((item) => ({
        location: {
          file: item.path,
          ...(item.line === undefined ? {} : { line: item.line }),
        },
        message: item.message,
        snippet: item.snippet,
      }));

    ctx.review.observe({
      key: `go-cli.model.${observation.id}`,
      summary: `[${observation.severity}/${observation.confidence}] ${observation.title}: ${observation.summary}`,
      ...(evidence.length === 0 ? {} : { evidence }),
      metadata: {
        source: "model",
        category: observation.category,
        severity: observation.severity,
        confidence: observation.confidence,
        whyItMatters: observation.whyItMatters,
        recommendation: observation.recommendation,
        evidenceIds: observation.evidenceIds,
      },
    });
  }
}

export async function runModelCliReview(
  ctx: RuleContext,
  analysis: Analysis,
  files: DiscoveryFile[],
  staticSeverities: StaticSeverity[] = [],
  staticPrimaryConcern?: string,
): Promise<"applied" | "unavailable"> {
  const { request, evidenceById } = buildModelReviewRequestFromDiscovery(
    ctx.change,
    analysis,
    files,
  );
  try {
    const result = await ctx.model.review<ModelCliReview>(request);
    await applyModelCliReview(
      ctx,
      result.output,
      evidenceById,
      staticSeverities,
      staticPrimaryConcern,
    );
    return "applied";
  } catch (error) {
    if (error instanceof ModelUnavailableError) {
      return "unavailable";
    }
    // Non-fatal model/provider failures must not hide static findings already emitted.
    if (error instanceof ModelReviewError || (error instanceof Error && /model|broker|fireworks|openai|anthropic/i.test(error.message))) {
      return "unavailable";
    }
    throw error;
  }
}

function evidenceIdForSignal(signal: Signal): string {
  return `det:${signal.ruleId}:${signal.path}:${signal.line}`;
}

function prioritizePaths(paths: readonly string[], changedFiles: readonly string[]): string[] {
  const changed = new Set(changedFiles);
  const unique = [...new Set(paths.filter((path) => path.length > 0))];
  return unique.sort((left, right) => {
    const leftChanged = changed.has(left) ? 0 : 1;
    const rightChanged = changed.has(right) ? 0 : 1;
    if (leftChanged !== rightChanged) return leftChanged - rightChanged;
    return pathPriority(left) - pathPriority(right) || left.localeCompare(right);
  });
}

function severityRank(severity: StaticSeverity | ModelCliObservation["severity"]): number {
  switch (severity) {
    case "critical":
      return 4;
    case "high":
      return 3;
    case "medium":
      return 2;
    case "low":
      return 1;
    case "none":
      return 0;
  }
}

/**
 * Walk candidates in priority order. Valid noun phrases pass through with no
 * broker hop; free-form drafts are rewritten via ctx.model.concern (SDK → CLI
 * broker) before falling through to the next candidate.
 */
async function resolveOpinionConcern(
  ctx: RuleContext,
  candidates: Array<string | undefined>,
): Promise<string | undefined> {
  for (const candidate of candidates) {
    if (candidate === undefined || candidate.trim() === "") continue;
    if (isOpinionConcernPhrase(candidate)) {
      return requireOpinionConcern(candidate);
    }
    try {
      const result = await ctx.model.concern({ text: candidate });
      return result.concern;
    } catch {
      // Try the next candidate (rewrite rejected or model error).
    }
  }
  return undefined;
}

function categoryConcern(category: string): string | undefined {
  switch (category) {
    case "cancellation":
      return "broken command cancellation context";
    case "exit-codes":
      return "incorrect process exit-code handling";
    case "stdout-stderr":
      return "stdout and stderr contract violations";
    case "flags-args":
      return "incompatible flag or argument defaults";
    case "subprocess":
    case "automation":
      return "subprocesses that ignore cancellation";
    case "completeness":
      return "incomplete command implementation";
    case "errors":
      return "non-actionable command error behavior";
    case "configuration":
      return "configuration compatibility issues";
    case "command-behavior":
      return "incorrect command behavior";
    case "interactive":
      return "interactive versus non-interactive contract issues";
    case "json-contract":
      return "inconsistent machine-readable output contracts";
    case "deprecation":
      return "deprecated flag output contract skew";
    case "validation-order":
      return "validation after irreversible side effects";
    case "dry-run":
      return "dry-run and apply flag interaction bugs";
    default:
      return undefined;
  }
}

function maxSeverity(values: Array<StaticSeverity | ModelCliObservation["severity"]>): StaticSeverity {
  let best: StaticSeverity = "none";
  for (const value of values) {
    if (severityRank(value) > severityRank(best)) {
      best = value;
    }
  }
  return best;
}
