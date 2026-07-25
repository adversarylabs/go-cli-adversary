import {
  formatOpinion,
  isOpinionConcernPhrase,
  ModelUnavailableError,
  requireOpinionConcern,
  type ChangeContext,
  type ModelReviewRequest,
  type RuleContext,
} from "@adversarylabs/sdk";
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

Do NOT review generic Go style, broad security, observability, databases, or general engineering quality unless it directly breaks the CLI contract.

Use only the prepared evidence and source excerpts. Cite evidence with the provided evidence IDs.
Return a small number of high-confidence observations (zero is valid). Prefer severity that matches user impact.

For each observation.title use a short headline. Prefer noun phrases when possible.
If you set primaryConcern, it must be a short noun phrase (for example \"forced exit code 124\"), never a full sentence.`;

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

export function applyModelCliReview(
  ctx: RuleContext,
  output: ModelCliReview,
  evidenceById: Map<string, PreparedEvidenceItem>,
  staticSeverities: StaticSeverity[] = [],
): void {
  const modelObservationSeverities = output.observations.map((item) => item.severity);
  const risk = maxSeverity([
    output.assessment.risk,
    ...staticSeverities,
    ...modelObservationSeverities,
  ]);

  ctx.review.assessment({
    risk,
    summary: output.assessment.summary,
  });

  const rankedObservations = output.observations.slice().sort(
    (left, right) =>
      severityRank(right.severity) - severityRank(left.severity) || left.id.localeCompare(right.id),
  );
  // Never advertise ship-as-is when static or model work still shows material issues.
  const blocking =
    staticSeverities.some((severity) => severityRank(severity) >= severityRank("medium")) ||
    modelObservationSeverities.some((severity) => severityRank(severity) >= severityRank("medium"));
  const ship = output.ship && !blocking;

  // Opinion prose is "I would address <concern> before …". Only pass phrases that
  // pass SDK requireOpinionConcern (noun phrases), never free-form model essays.
  const concern = resolveOpinionConcern([
    rankedObservations[0]?.title,
    output.primaryConcern,
    rankedObservations[0] === undefined ? undefined : categoryConcern(rankedObservations[0].category),
  ]);

  ctx.review.opinion(
    formatOpinion({
      ship,
      ...(concern === undefined ? {} : { concern }),
      change: ctx.change,
    }),
  );

  for (const observation of output.observations.slice(0, MAX_MODEL_OBSERVATIONS)) {
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
): Promise<"applied" | "unavailable"> {
  const { request, evidenceById } = buildModelReviewRequestFromDiscovery(
    ctx.change,
    analysis,
    files,
  );
  try {
    const result = await ctx.model.review<ModelCliReview>(request);
    applyModelCliReview(ctx, result.output, evidenceById, staticSeverities);
    return "applied";
  } catch (error) {
    if (error instanceof ModelUnavailableError) {
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

function pathPriority(path: string): number {
  const normalized = path.replaceAll("\\", "/");
  if (/(^|\/)main\.go$/.test(normalized)) return 0;
  if (/(^|\/)cmd\//.test(normalized) || /(^|\/)cli\//.test(normalized)) return 1;
  if (/(^|\/)internal\/(cmd|cli|app|command)\//.test(normalized)) return 2;
  if (/(^|\/)pkg\//.test(normalized) || /(^|\/)internal\//.test(normalized)) return 4;
  return 3;
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
 * Try candidates until one is a valid SDK noun-phrase concern.
 * Derives short subjects from clause titles when possible.
 */
function resolveOpinionConcern(candidates: Array<string | undefined>): string | undefined {
  for (const candidate of candidates) {
    if (candidate === undefined) continue;
    for (const derived of deriveConcernCandidates(candidate)) {
      if (isOpinionConcernPhrase(derived)) {
        return requireOpinionConcern(derived);
      }
    }
  }
  return undefined;
}

function deriveConcernCandidates(raw: string): string[] {
  const normalized = raw.trim().replace(/\s+/g, " ");
  if (normalized === "") return [];
  const out: string[] = [];
  const push = (value: string | undefined) => {
    // SDK rejects ".!?" anywhere (so identifiers like os.Exit cannot be concerns).
    const cleaned = value?.trim().replace(/[.!?,:;]+$/g, "");
    if (cleaned && !/[.!?]/.test(cleaned) && !out.includes(cleaned)) {
      out.push(cleaned);
    }
  };

  // "… forces exit code 124 regardless …" -> "forced exit code 124"
  const forcedCode = normalized.match(
    /\b(?:forces?|overrides?|causes?)\s+((?:an?\s+|the\s+)?(?:exit\s+)?code\s+\d+)\b/i,
  );
  if (forcedCode?.[1] !== undefined) {
    const code = forcedCode[1].replace(/^(an?|the)\s+/i, "").trim();
    push(`forced ${code}`);
  }

  // "Commands replace/discard inherited context with X" -> "inherited context in command handlers"
  const replaceShape = normalized.match(
    /^(?:commands?|handlers?|paths?)\s+(?:replace|discard|use|start with)\s+(.+?)(?:\s*,|\s+with\b|\s+instead\b|$)/i,
  );
  if (replaceShape?.[1] !== undefined) {
    push(`${replaceShape[1].trim()} in command handlers`);
  }

  // Prefer short titles without sentence punctuation as-is.
  const firstSentence = normalized.split(/(?<=[.!?])\s+/)[0] ?? normalized;
  push(firstSentence.replace(/[.!?]+$/g, "").trim());

  // Last resort: first few words without terminal punctuation or dotted identifiers.
  const words = firstSentence
    .replace(/[.!?]+$/g, "")
    .trim()
    .split(/\s+/)
    .filter((word) => !/[.!?]/.test(word));
  push(words.slice(0, 6).join(" "));

  return out;
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
