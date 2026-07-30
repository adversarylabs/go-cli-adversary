import assert from "node:assert/strict";
import { cp, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createApp } from "../src/index.ts";

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));

async function isolatedFixture(fixture: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "go-cli-p0-"));
  await cp(fixture, root, { recursive: true });
  return root;
}

const review = async (rel: string) => {
  const root = await isolatedFixture(join(projectRoot, "fixtures", rel));
  return createApp().run({ input: { source: { path: root } }, includeRawObservations: true });
};

test("P0 catalog go-cli rules detect vulnerable fixtures and stay quiet on clean", async () => {
  const cases = [
    // context.missing
    { dir: "p0-context", id: "go-cli.cancellation" },
    { dir: "p0-subprocess-context", id: "go-cli.subprocess-no-context" },
    // exit.codes
    { dir: "p0-exit-codes", id: "go-cli.exit-code-convention" },
    { dir: "p0-execute-error", id: "go-cli.execute-error" },
    { dir: "p0-exit-bypass", id: "go-cli.exit-bypass" },
    // flags.password-argv (new)
    { dir: "p0-password-argv", id: "go-cli.flags-password-argv" },
    // errors.silent → execute-error (blank discard)
    { dir: "p0-errors-silent", id: "go-cli.execute-error" },
    // update.insecure (new)
    { dir: "p0-update-insecure", id: "go-cli.update-insecure" },
  ] as const;

  for (const c of cases) {
    const bad = await review(`${c.dir}/vulnerable`);
    assert.equal(
      bad.findings.some((f) => f.ruleId === c.id),
      true,
      `${c.id} missed on ${c.dir}/vulnerable; got ${bad.findings.map((f) => f.ruleId).join(",") || "(none)"}`,
    );
    const good = await review(`${c.dir}/clean`);
    assert.equal(
      good.findings.some((f) => f.ruleId === c.id),
      false,
      `${c.id} flagged clean ${c.dir}/clean; got ${good.findings.map((f) => f.ruleId).join(",")}`,
    );
  }
});
