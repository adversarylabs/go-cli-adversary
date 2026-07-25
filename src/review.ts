import { formatOpinion, requireOpinionConcern, type RuleContext } from "@adversarylabs/sdk";
import { domain } from "./domain.js";
import { runModelCliReview, type DiscoveryFile } from "./model-review.js";
import { isCommandPath, isNonProductPath, pathPriority } from "./paths.js";
import { type Analysis, type RuleDefinition, type Signal } from "./types.js";

const RISK_ORDER = { none: 0, low: 1, medium: 2, high: 3, critical: 4 } as const;
/** Evidence samples attached to each finding (full total lives in metadata.occurrences). */
const MAX_EVIDENCE_SAMPLES = 8;
/** Maximum findings emitted — force a short, ordered review. */
const MAX_FINDINGS = 3;

/** Rules that are noisy in library packages; keep command-path hits when any exist. */
const COMMAND_SCOPED_RULES = new Set([
  "go-cli.cancellation",
  "go-cli.subprocess-no-context",
  "go-cli.exit-bypass",
]);

export async function reviewDomain(
  ctx: RuleContext,
  analysis: Analysis,
  discoveryFiles: DiscoveryFile[] = [],
): Promise<void> {
  const candidates: Array<{ rule: RuleDefinition; total: number; samples: Signal[] }> = [];
  for (const rule of domain.rules) {
    const raw = analysis.signals.filter((signal) => signal.ruleId === rule.id);
    if (raw.length === 0) continue;
    const selected = selectSignals(rule.id, raw);
    if (selected.total === 0) continue;
    candidates.push({ rule, total: selected.total, samples: selected.samples });
  }

  const ranked = [...candidates].sort(
    (left, right) =>
      RISK_ORDER[right.rule.severity] - RISK_ORDER[left.rule.severity] ||
      right.total - left.total ||
      left.rule.id.localeCompare(right.rule.id),
  );
  const active = ranked.slice(0, MAX_FINDINGS);

  for (const item of active) {
    ctx.finding({
      ruleId: item.rule.id,
      title: item.rule.title,
      category: item.rule.category,
      severity: item.rule.severity,
      confidence: item.rule.confidence,
      summary: item.rule.summary(item.total),
      whyItMatters: item.rule.whyItMatters,
      impact: item.rule.impact,
      evidence: item.samples.map((signal) => ({
        location: {
          file: signal.path,
          line: signal.line,
          ...(signal.endLine === undefined ? {} : { endLine: signal.endLine }),
        },
        message: signal.message,
        snippet: signal.snippet,
        data: signal.data,
      })),
      recommendation: item.rule.recommendation,
      remediation: { complexity: "small" },
      metadata: {
        occurrences: item.total,
        sampled: item.samples.length,
      },
    });
  }

  addPositives(
    ctx,
    analysis,
    active.map((item) => item.rule.id),
  );

  const staticSeverities = active.map((item) => item.rule.severity);
  const staticPrimaryConcern = active[0]?.rule.concern;
  const modelStatus = await runModelCliReview(
    ctx,
    analysis,
    discoveryFiles,
    staticSeverities,
    staticPrimaryConcern,
  );
  if (modelStatus === "applied") {
    return;
  }

  if (active.length === 0) {
    ctx.review.assessment({ risk: "none", summary: domain.noRiskSummary });
    ctx.review.opinion({ ship: true, summary: domain.approvalSummary });
    return;
  }

  const primary = active[0]!;
  ctx.review.assessment({
    risk: primary.rule.severity,
    summary: assessmentSummary(active),
  });
  ctx.review.opinion(
    formatOpinion({
      ship: primary.rule.severity === "low",
      concern: requireOpinionConcern(primary.rule.concern),
      change: ctx.change,
    }),
  );
}

function selectSignals(
  ruleId: string,
  signals: Signal[],
): { total: number; samples: Signal[] } {
  // Never surface scripts/tools/testdata as product CLI lifecycle findings.
  let pool = signals.filter((signal) => !isNonProductPath(signal.path));
  if (pool.length === 0) {
    return { total: 0, samples: [] };
  }
  if (COMMAND_SCOPED_RULES.has(ruleId)) {
    const commandHits = pool.filter((signal) => isCommandPath(signal.path));
    if (commandHits.length > 0) {
      pool = commandHits;
    }
  }
  const sorted = [...pool].sort(
    (left, right) =>
      pathPriority(left.path) - pathPriority(right.path) ||
      left.path.localeCompare(right.path) ||
      left.line - right.line,
  );
  return {
    total: pool.length,
    samples: sorted.slice(0, MAX_EVIDENCE_SAMPLES),
  };
}

function assessmentSummary(active: Array<{ rule: RuleDefinition; total: number }>): string {
  if (active.length === 1) {
    const only = active[0]!;
    return `Fix first: ${only.rule.concern} (${siteLabel(only.total)}).`;
  }
  const ordered = active
    .slice(0, MAX_FINDINGS)
    .map((item, index) => `${index + 1}) ${item.rule.concern} (${siteLabel(item.total)})`)
    .join("; ");
  return `${active.length} priority lifecycle issues — address in order: ${ordered}.`;
}

function siteLabel(count: number): string {
  return count === 1 ? "1 site" : `${count} sites`;
}

function addPositives(ctx: RuleContext, analysis: Analysis, activeRuleIds: string[]): void {
  const byKey = new Map<string, typeof analysis.positives>();
  for (const item of analysis.positives) {
    const existing = byKey.get(item.key) ?? [];
    existing.push(item);
    byKey.set(item.key, existing);
  }
  const hasCancellationFinding = activeRuleIds.includes("go-cli.cancellation");
  for (const [key, items] of [...byKey].sort(([left], [right]) => left.localeCompare(right))) {
    let summary = positiveSummary(items[0]!.summary, items.length);
    if (hasCancellationFinding && key === "go-cli.context-propagated") {
      summary = positiveSummary(
        "Command cancellation is propagated in some command paths.",
        items.length,
      );
    }
    const note = {
      key,
      summary,
      evidence: items.slice(0, 8).map((item) => ({
        location: { file: item.path, line: item.line },
        message: item.summary,
      })),
    };
    if (items.length > 1) {
      ctx.review.positive({ ...note, metadata: { locations: items.length } });
    } else {
      ctx.review.positive(note);
    }
  }
}

function positiveSummary(base: string, count: number): string {
  if (count <= 1) return base;
  const core = base.replace(/\.\s*$/, "");
  return `${core} (${count} locations).`;
}
