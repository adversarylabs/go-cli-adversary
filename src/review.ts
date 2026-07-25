import { formatOpinion, type RuleContext } from "@adversarylabs/sdk";
import { domain } from "./domain.js";
import { type Analysis, type RuleDefinition, type Signal } from "./types.js";

const RISK_ORDER = { none: 0, low: 1, medium: 2, high: 3, critical: 4 } as const;

export function reviewDomain(ctx: RuleContext, analysis: Analysis): void {
  const active: Array<{ rule: RuleDefinition; signals: Signal[] }> = [];
  for (const rule of domain.rules) {
    const signals = analysis.signals.filter((signal) => signal.ruleId === rule.id);
    if (signals.length === 0) continue;
    active.push({ rule, signals });
    ctx.finding({
      ruleId: rule.id,
      title: rule.title,
      category: rule.category,
      severity: rule.severity,
      confidence: rule.confidence,
      summary: rule.summary(signals.length),
      whyItMatters: rule.whyItMatters,
      impact: rule.impact,
      evidence: signals.slice(0, 12).map((signal) => ({
        location: {
          file: signal.path,
          line: signal.line,
          ...(signal.endLine === undefined ? {} : { endLine: signal.endLine }),
        },
        message: signal.message,
        snippet: signal.snippet,
        data: signal.data,
      })),
      recommendation: rule.recommendation,
      remediation: { complexity: "small" },
    });
  }

  addPositives(ctx, analysis);
  if (active.length === 0) {
    ctx.review.assessment({ risk: "none", summary: domain.noRiskSummary });
    ctx.review.opinion({ ship: true, summary: domain.approvalSummary });
    return;
  }

  const primary = [...active].sort((left, right) =>
    RISK_ORDER[right.rule.severity] - RISK_ORDER[left.rule.severity] ||
    left.rule.id.localeCompare(right.rule.id))[0]!;
  ctx.review.assessment({
    risk: primary.rule.severity,
    summary: assessmentSummary(active, primary.rule),
  });
  // Posture (merge / commit / ship) comes from the runner via ctx.change.
  ctx.review.opinion(
    formatOpinion({
      ship: primary.rule.severity === "low",
      concern: primary.rule.concern,
      change: ctx.change,
    }),
  );
}

function assessmentSummary(
  active: Array<{ rule: RuleDefinition; signals: Signal[] }>,
  primary: RuleDefinition,
): string {
  if (active.length === 1) {
    return `The primary lifecycle concern is ${primary.concern}.`;
  }
  return `${active.length} lifecycle issues were identified; the highest-severity is ${primary.concern}.`;
}

function addPositives(ctx: RuleContext, analysis: Analysis): void {
  const byKey = new Map<string, typeof analysis.positives>();
  for (const item of analysis.positives) {
    const existing = byKey.get(item.key) ?? [];
    existing.push(item);
    byKey.set(item.key, existing);
  }
  for (const [key, items] of [...byKey].sort(([left], [right]) => left.localeCompare(right))) {
    const note = {
      key,
      summary: positiveSummary(items[0]!.summary, items.length),
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
