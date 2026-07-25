import { contentSignal, lineSignals, positive } from "./signals.js";
import { type DomainDefinition } from "./types.js";

export const domain: DomainDefinition = {
  name: "go-cli",
  displayName: "Go CLI",
  observationKey: "go-cli.analysis",
  sourceDescription: "Go CLI",
  includePath: (path) => path.endsWith(".go") && !path.endsWith("_test.go"),
  rules: [
    {
      id: "go-cli.exit-bypass",
      title: "Command code terminates the process directly",
      concern: "direct process termination below the application boundary",
      category: "correctness",
      severity: "high",
      confidence: "high",
      summary: (count) => `${count} command path${count === 1 ? "" : "s"} call os.Exit below the application boundary.`,
      whyItMatters: "Direct process termination skips deferred cleanup and prevents callers or tests from handling the failure.",
      impact: "Cleanup, telemetry flushes, and user-facing error mapping can be skipped.",
      recommendation: "Return a typed error from command execution and map it to an exit code once in main.",
    },
    {
      id: "go-cli.execute-error",
      title: "The root command error is discarded",
      concern: "discarded root command execution errors",
      category: "correctness",
      severity: "high",
      confidence: "high",
      summary: (count) => `${count} root command execution${count === 1 ? "" : "s"} ignore the returned error.`,
      whyItMatters: "Cobra, Kong, and urfave command execution errors are the contract for diagnostics and exit status.",
      impact: "Automation receives a successful exit even though the command failed.",
      recommendation: "Handle the returned error at main, print one stable diagnostic, and exit with a non-zero mapped status.",
    },
    {
      id: "go-cli.cancellation",
      title: "Long-running command work starts from a non-cancellable context",
      concern: "non-cancellable context.Background in command work",
      category: "reliability",
      severity: "medium",
      confidence: "high",
      summary: (count) => `${count} command execution path${count === 1 ? "" : "s"} replace the command context with context.Background.`,
      whyItMatters: "Command frameworks and signal handlers propagate cancellation through the command context.",
      impact: "Ctrl-C or orchestration cancellation may not stop network, filesystem, or worker activity.",
      recommendation: "Pass cmd.Context() or the framework-provided context through every long-running operation.",
    },
  ],
  noRiskSummary: "The reviewed command paths preserve errors, cancellation, and process-boundary ownership.",
  approvalSummary: "I would approve the reviewed CLI lifecycle and automation behavior.",
  analyze(file) {
    return {
      signals: [
        ...lineSignals(file, "go-cli.exit-bypass", /\bos\.Exit\s*\(/, () => "This command path terminates the process directly."),
        ...contentSignal(
          file,
          "go-cli.execute-error",
          /^\s*(?:rootCmd|cmd|app)\.Execute(?:Context)?\(\)\s*$/m,
          "The command execution error is not inspected or returned.",
        ),
        ...lineSignals(
          file,
          "go-cli.cancellation",
          /\bcontext\.Background\s*\(\)/,
          () => "The command replaces its inherited cancellation context.",
        ),
      ],
      positives: [
        ...positive(file, "go-cli.context-propagated", /\bcmd\.Context\s*\(\)/, "Command cancellation is propagated into application work."),
        ...positive(file, "go-cli.error-owned", /if err := .*\.Execute(?:Context)?\(/, "The process boundary owns command error-to-exit mapping."),
      ],
    };
  },
};
