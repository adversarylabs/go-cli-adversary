#!/usr/bin/env node

import { realpath } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { Adversary } from "@adversarylabs/sdk";
import { analyzeDiscovery } from "./analyze.js";
import { discoverSources } from "./discover.js";
import { domain } from "./domain.js";
import { reviewDomain } from "./review.js";

export function createApp(): Adversary {
  const app = new Adversary({
    name: domain.name,
    version: "0.0.1",
    review: { maximumFindings: 5, minimumConfidence: "medium" },
  });

  app.rule(`${domain.name}.review`, async (ctx) => {
    const discovery = await discoverSources(ctx.repoPath, ctx.change);
    const analysis = await analyzeDiscovery(discovery);
    ctx.summary.files_scanned = analysis.filesScanned;
    // Analysis prep is context for the runner (files scanned, mode), not a user-facing
    // review observation. Keep metadata on a context-role note for tooling only.
    if (analysis.parseErrors.length > 0) {
      ctx.review.observe({
        key: domain.observationKey,
        summary: `Parsed ${analysis.filesScanned} ${domain.sourceDescription} files with ${analysis.parseErrors.length} parse error${analysis.parseErrors.length === 1 ? "" : "s"}.`,
        metadata: {
          role: "context",
          parser: "tree-sitter-go",
          mode: analysis.mode,
          parseErrors: analysis.parseErrors.length,
        },
      });
    }
    reviewDomain(ctx, analysis);
  });
  return app;
}

async function runIfDirect(): Promise<void> {
  if (
    process.argv[1] !== undefined &&
    (await realpath(process.argv[1])) === (await realpath(fileURLToPath(import.meta.url)))
  ) {
    await createApp().runFromEnvironment();
  }
}

void runIfDirect();
