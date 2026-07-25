import {
  isNonProductPath,
  isProcessBoundaryExit,
  isRootSignalBootstrap,
} from "./paths.js";
import { contentSignal, lineSignals, positive } from "./signals.js";
import { type DomainDefinition, type Signal, type SourceRevision } from "./types.js";

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
      summary: (count) =>
        `${count} command path${count === 1 ? "" : "s"} terminate the process below the application boundary.`,
      whyItMatters:
        "Direct process termination skips deferred cleanup and prevents callers or tests from handling the failure.",
      impact: "Cleanup, telemetry flushes, and user-facing error mapping can be skipped.",
      recommendation:
        "Return a typed error from command execution and map it to an exit code once in main.",
    },
    {
      id: "go-cli.execute-error",
      title: "The root command error is discarded",
      concern: "discarded root command execution errors",
      category: "correctness",
      severity: "high",
      confidence: "high",
      summary: (count) =>
        `${count} root command execution${count === 1 ? "" : "s"} ignore the returned error.`,
      whyItMatters:
        "Cobra, Kong, and urfave command execution errors are the contract for diagnostics and exit status.",
      impact: "Automation receives a successful exit even though the command failed.",
      recommendation:
        "Handle the returned error at main, print one stable diagnostic, and exit with a non-zero mapped status.",
    },
    {
      id: "go-cli.cancellation",
      title: "Long-running command work starts from a non-cancellable context",
      concern: "non-cancellable context in command work",
      category: "reliability",
      severity: "medium",
      confidence: "high",
      summary: (count) =>
        `${count} command path${count === 1 ? "" : "s"} start work from context.Background or context.TODO.`,
      whyItMatters:
        "Command frameworks and signal handlers propagate cancellation through the command context.",
      impact: "Ctrl-C or orchestration cancellation may not stop network, filesystem, or worker activity.",
      recommendation:
        "Pass cmd.Context() or the framework-provided context through every long-running operation.",
    },
    {
      id: "go-cli.subprocess-no-context",
      title: "Subprocess launch does not inherit cancellation",
      concern: "subprocesses launched without CommandContext",
      category: "reliability",
      severity: "medium",
      confidence: "high",
      summary: (count) =>
        `${count} subprocess launch${count === 1 ? "" : "es"} use exec.Command without a parent context.`,
      whyItMatters:
        "Child processes started without CommandContext keep running after the CLI is cancelled or times out.",
      impact: "Orphaned git, curl, docker, and build processes continue after Ctrl-C or CI cancellation.",
      recommendation:
        "Use exec.CommandContext with the command context so children are killed or wait with cancellation.",
    },
    {
      id: "go-cli.shell-interpolation",
      title: "Shell is used to interpolate a command string",
      concern: "shell -c command interpolation",
      category: "security",
      severity: "high",
      confidence: "medium",
      summary: (count) =>
        `${count} command path${count === 1 ? "" : "s"} invoke a shell with -c to run a composed string.`,
      whyItMatters:
        "Shell interpolation turns path and argument data into executable syntax and is a common injection boundary.",
      impact: "User-controlled paths or refs can escape the intended command and run arbitrary shell code.",
      recommendation:
        "Prefer exec.Command/CommandContext with an argv slice; avoid sh -c / bash -c unless the script is a constant.",
    },
  ],
  noRiskSummary: "The reviewed command paths preserve errors, cancellation, and process-boundary ownership.",
  approvalSummary: "I would approve the reviewed CLI lifecycle and automation behavior.",
  analyze(file) {
    return {
      signals: [
        ...exitBypassSignals(file),
        ...contentSignal(
          file,
          "go-cli.execute-error",
          /^\s*(?:rootCmd|cmd|app)\.Execute(?:Context)?\(\)\s*$/m,
          "The command execution error is not inspected or returned.",
        ),
        ...cancellationSignals(file),
        ...subprocessSignals(file),
        ...shellInterpolationSignals(file),
      ],
      positives: [
        ...positive(
          file,
          "go-cli.context-propagated",
          /\bcmd\.Context\s*\(\)/,
          "Command cancellation is propagated into application work.",
        ),
        ...positive(
          file,
          "go-cli.error-owned",
          /if err := .*\.Execute(?:Context)?\(/,
          "The process boundary owns command error-to-exit mapping.",
        ),
        ...positive(
          file,
          "go-cli.subprocess-context",
          /\bexec\.CommandContext\s*\(/,
          "Subprocesses inherit the command cancellation context.",
        ),
      ],
    };
  },
};

function exitBypassSignals(file: SourceRevision): Signal[] {
  if (isNonProductPath(file.path)) return [];
  return lineSignals(
    file,
    "go-cli.exit-bypass",
    /\b(?:os\.Exit|log\.Fatal(?:f|ln)?|logrus\.Fatal(?:f|ln)?|zap\.L\(\)\.Fatal|logger\.Fatal(?:f|ln)?)\s*\(/,
    (match) => {
      const call = match[0] ?? "process exit";
      if (call.includes("Fatal")) {
        return `This command path terminates the process via ${call.replace(/\s*\($/, "")}.`;
      }
      return "This command path terminates the process directly.";
    },
  ).filter((signal) => !isProcessBoundaryExit(signal.snippet, signal.path));
}

function cancellationSignals(file: SourceRevision): Signal[] {
  if (isNonProductPath(file.path)) return [];
  const lines = file.current.split("\n");
  return lineSignals(
    file,
    "go-cli.cancellation",
    /\bcontext\.(?:Background|TODO)\s*\(\)/,
    (match) =>
      match[0]?.includes("TODO")
        ? "The command starts work from context.TODO instead of the inherited context."
        : "The command replaces its inherited cancellation context with context.Background.",
  ).filter((signal) => {
    const index = signal.line - 1;
    const surrounding = lines.slice(Math.max(0, index - 2), index + 1).join("\n");
    return !isRootSignalBootstrap(signal.snippet, surrounding);
  });
}

function subprocessSignals(file: SourceRevision): Signal[] {
  if (isNonProductPath(file.path)) return [];
  return lineSignals(
    file,
    "go-cli.subprocess-no-context",
    /\bexec\.Command\s*\(/,
    () => "This subprocess is launched with exec.Command and does not inherit cancellation.",
  ).filter(
    (signal) =>
      !signal.snippet.includes("CommandContext") &&
      !/"(?:\/bin\/)?(?:ba)?sh"\s*,\s*"-c"/.test(signal.snippet),
  );
}

function shellInterpolationSignals(file: SourceRevision): Signal[] {
  if (isNonProductPath(file.path)) return [];
  return lineSignals(
    file,
    "go-cli.shell-interpolation",
    /\bexec\.Command(?:Context)?\s*\(\s*"(?:\/bin\/)?(?:ba)?sh"\s*,\s*"-c"/,
    () => "This command invokes a shell with -c to run a composed string.",
  );
}
