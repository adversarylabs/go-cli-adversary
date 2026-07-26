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
    {
      id: "go-cli.exit-code-convention",
      title: "Exit-code helper uses 2 as a catch-all runtime failure",
      concern: "exit code 2 used as catch-all runtime failure",
      category: "correctness",
      severity: "medium",
      confidence: "medium",
      summary: (count) =>
        `${count} exit-code path${count === 1 ? "" : "s"} use status 2 as a generic failure (conventionally usage).`,
      whyItMatters:
        "Exit code 2 is conventionally reserved for usage/validation errors; runtime failures usually use 1.",
      impact: "Automation that treats 2 as usage will mis-handle generic runtime failures.",
      recommendation:
        "Map usage/validation errors to 2 and unclassified runtime failures to 1 (or a documented domain code).",
    },
    {
      id: "go-cli.subprocess-stderr-discarded",
      title: "Subprocess stdout is captured while stderr is discarded",
      concern: "subprocess stderr discarded from diagnostics",
      category: "reliability",
      severity: "medium",
      confidence: "medium",
      summary: (count) =>
        `${count} subprocess path${count === 1 ? "" : "s"} use Output() which discards child stderr.`,
      whyItMatters: "Child process failures are hard to diagnose when stderr never reaches the user or logs.",
      impact: "Failed git/docker/tool invocations surface only exit status without the tool's error text.",
      recommendation:
        "Use CombinedOutput, attach cmd.Stderr to the CLI error stream, or capture stderr into the error message.",
    },
    {
      id: "go-cli.stdout-progress",
      title: "Progress or diagnostics are written to stdout",
      concern: "progress mixed onto the machine-readable stdout stream",
      category: "correctness",
      severity: "medium",
      confidence: "medium",
      summary: (count) =>
        `${count} path${count === 1 ? "" : "s"} write progress-style diagnostics to stdout instead of stderr.`,
      whyItMatters: "Pipelines and --format json consumers break when progress shares stdout with the payload.",
      impact: "Scripts piping CLI output to jq or files receive corrupted machine output.",
      recommendation: "Send progress, warnings, and status lines to stderr; keep stdout for the primary result.",
    },
    {
      id: "go-cli.interactive-no-tty",
      title: "Interactive input is read without a non-TTY guard",
      concern: "interactive prompts without non-TTY protection",
      category: "reliability",
      severity: "medium",
      confidence: "medium",
      summary: (count) =>
        `${count} path${count === 1 ? "" : "s"} read interactive stdin without an obvious terminal guard.`,
      whyItMatters: "CI and automation hang or fail unpredictably when prompts run without a TTY.",
      impact: "Pipelines and non-interactive agents block on confirmations that never receive input.",
      recommendation:
        "Guard prompts with term.IsTerminal (or equivalent) and require --yes/--force for non-interactive runs.",
    },
    {
      id: "go-cli.http-no-timeout",
      title: "HTTP client has no timeout budget",
      concern: "network clients without timeout budgets",
      category: "reliability",
      severity: "medium",
      confidence: "high",
      summary: (count) =>
        `${count} HTTP client${count === 1 ? "" : "s"} are constructed without an explicit Timeout.`,
      whyItMatters: "Hung network calls leave the CLI wedged with no user-visible deadline.",
      impact: "Ctrl-C may still work if context is used, but default clients stall indefinitely on dead peers.",
      recommendation: "Set http.Client.Timeout or always use request contexts with deadlines.",
    },
    {
      id: "go-cli.cobra-silence-usage",
      title: "Cobra command does not silence usage on runtime errors",
      concern: "usage dumped on runtime command failures",
      category: "correctness",
      severity: "low",
      confidence: "medium",
      summary: (count) =>
        `${count} Cobra command definition${count === 1 ? "" : "s"} omit SilenceUsage for runtime failures.`,
      whyItMatters:
        "Printing full usage on every runtime error hides the real failure and confuses automation logs.",
      impact: "Operators and CI logs fill with flag help instead of the actionable error.",
      recommendation:
        "Set SilenceUsage: true on the root (and typically subcommands), and only show usage for parse/validation errors.",
    },
    {
      id: "go-cli.version-identity",
      title: "CLI root lacks an inspectable version identity",
      concern: "missing version or build identity on the CLI root",
      category: "reliability",
      severity: "low",
      confidence: "medium",
      summary: (count) =>
        `${count} CLI root definition${count === 1 ? "" : "s"} have no Version field or version helper reference.`,
      whyItMatters: "Support and release verification require a stable --version / Version surface.",
      impact: "Users and automation cannot tell which build failed in the field.",
      recommendation:
        "Set cobra.Command.Version (or urfave Version) from ldflags / runtime/debug.ReadBuildInfo.",
    },
    {
      id: "go-cli.json-without-format",
      title: "JSON is written to stdout without an obvious format switch",
      concern: "machine JSON without a format or json flag in the same file",
      category: "correctness",
      severity: "medium",
      confidence: "medium",
      summary: (count) =>
        `${count} path${count === 1 ? "" : "s"} encode JSON to stdout without a local format/json flag switch.`,
      whyItMatters: "List/get commands need a stable machine mode; mixed human+JSON without a switch breaks scripts.",
      impact: "Callers cannot reliably select machine-readable output for the command.",
      recommendation:
        "Gate JSON encoding on --format json / --json (or always emit a documented machine contract).",
    },
    {
      id: "go-cli.bare-user-log",
      title: "Bare log package used for CLI user messaging",
      concern: "uncontrolled log package output for CLI UX",
      category: "correctness",
      severity: "low",
      confidence: "medium",
      summary: (count) =>
        `${count} path${count === 1 ? "" : "s"} use log.Print/Fatal-style messaging for CLI output.`,
      whyItMatters: "The log package prefixes and stream defaults fight intentional stdout/stderr contracts.",
      impact: "User messages appear on the wrong stream or with unwanted prefixes.",
      recommendation: "Write user-facing text via injected IO streams (stderr/stdout), not log.Printf.",
    },
    {
      id: "go-cli.init-side-effects",
      title: "Package init performs I/O or client construction",
      concern: "side effects in package init",
      category: "reliability",
      severity: "low",
      confidence: "medium",
      summary: (count) =>
        `${count} package init block${count === 1 ? "" : "s"} construct clients or perform I/O.`,
      whyItMatters: "init side effects make commands hard to test and can run before flags are parsed.",
      impact: "Imports trigger network/filesystem work unexpectedly.",
      recommendation: "Construct clients in main/App wiring after configuration is resolved.",
    },
    {
      id: "go-cli.os-args-outside-main",
      title: "Library/command package reads os.Args directly",
      concern: "os.Args used outside the process entrypoint",
      category: "reliability",
      severity: "low",
      confidence: "medium",
      summary: (count) =>
        `${count} non-main path${count === 1 ? "" : "s"} read os.Args instead of injected args.`,
      whyItMatters: "Direct os.Args coupling blocks unit tests and multi-command composition.",
      impact: "Command packages cannot be tested without mutating process-global arguments.",
      recommendation: "Accept args via cobra/urfave/flag sets or function parameters from main.",
    },
    {
      id: "go-cli.ansi-no-tty",
      title: "ANSI/spinner output without a terminal guard in-file",
      concern: "ANSI or spinner output without TTY detection",
      category: "correctness",
      severity: "low",
      confidence: "medium",
      summary: (count) =>
        `${count} path${count === 1 ? "" : "s"} emit spinner/ANSI sequences without an in-file TTY guard.`,
      whyItMatters: "Cursor and color control corrupt CI and piped logs.",
      impact: "Non-interactive environments receive escape noise in captured output.",
      recommendation: "Gate spinners/colors on term.IsTerminal (or disable when CI=true).",
    },
    {
      id: "go-cli.option-smuggling-risk",
      title: "Revision-like argument is passed to a subprocess without validation",
      concern: "subprocess args that may allow option smuggling",
      category: "security",
      severity: "medium",
      confidence: "medium",
      summary: (count) =>
        `${count} path${count === 1 ? "" : "s"} pass variables into git/docker/kubectl argv after options without an obvious validator.`,
      whyItMatters: "Unvalidated refs can be interpreted as child-process flags (`-x`).",
      impact: "User-controlled revision strings can change child tool behavior unexpectedly.",
      recommendation: "Validate refs (reject leading `-` / NUL) or use `--` before positional args.",
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
        ...exitCodeConventionSignals(file),
        ...subprocessStderrSignals(file),
        ...stdoutProgressSignals(file),
        ...interactiveNoTtySignals(file),
        ...httpNoTimeoutSignals(file),
        ...cobraSilenceUsageSignals(file),
        ...versionIdentitySignals(file),
        ...jsonWithoutFormatSignals(file),
        ...bareUserLogSignals(file),
        ...initSideEffectSignals(file),
        ...osArgsOutsideMainSignals(file),
        ...ansiNoTtySignals(file),
        ...optionSmugglingSignals(file),
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
        ...positive(
          file,
          "go-cli.http-timeout",
          /http\.Client\{[^}]*Timeout\s*:/,
          "HTTP clients set an explicit timeout budget.",
        ),
        ...positive(
          file,
          "go-cli.silence-usage",
          /\bSilenceUsage\s*:\s*true/,
          "Cobra usage output is silenced for runtime failures.",
        ),
        ...positive(
          file,
          "go-cli.version-set",
          /\bVersion\s*:/,
          "The command surface exposes a Version identity field.",
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

/** ExitCode helpers that fall through to return 2 (usage convention clash). */
function exitCodeConventionSignals(file: SourceRevision): Signal[] {
  if (isNonProductPath(file.path)) return [];
  if (!/\bfunc\b[\s\S]{0,120}\b\w*ExitCode\w*\s*\(/.test(file.current)) return [];
  return lineSignals(
    file,
    "go-cli.exit-code-convention",
    /^\s*return\s+2\b/,
    () => "This exit-code path returns 2, which is conventionally a usage error, as a fallback status.",
  );
}

/** Command.Output() drops child stderr from the returned diagnostics path. */
function subprocessStderrSignals(file: SourceRevision): Signal[] {
  if (isNonProductPath(file.path)) return [];
  return lineSignals(
    file,
    "go-cli.subprocess-stderr-discarded",
    /\.Output\s*\(\s*\)/,
    () => "This subprocess uses Output(), which does not capture child stderr for diagnostics.",
  ).filter((signal) => !signal.snippet.includes("CombinedOutput"));
}

/** Progress-style writes aimed at os.Stdout or bare fmt print (stdout). */
function stdoutProgressSignals(file: SourceRevision): Signal[] {
  if (isNonProductPath(file.path)) return [];
  const progressWord =
    /progress|spinner|download(?:ing)?|upload(?:ing)?|waiting|processing|please wait|% complete/i;
  return [
    ...lineSignals(
      file,
      "go-cli.stdout-progress",
      /\bfmt\.(?:Fprint|Fprintf|Fprintln)\(\s*os\.Stdout\b/,
      () => "This diagnostic is written to os.Stdout instead of stderr.",
    ),
    ...lineSignals(
      file,
      "go-cli.stdout-progress",
      /\bfmt\.(?:Print|Printf|Println)\(/,
      (match) => {
        const line = match.input ?? match[0] ?? "";
        if (!progressWord.test(line)) return "";
        return "This progress-style message is printed with fmt (stdout) instead of stderr.";
      },
    ).filter((signal) => signal.message !== ""),
  ];
}

/** Interactive stdin readers without an in-file terminal guard. */
function interactiveNoTtySignals(file: SourceRevision): Signal[] {
  if (isNonProductPath(file.path)) return [];
  if (/\b(?:term\.IsTerminal|isatty\.IsTerminal|IsTerminal\s*\()/.test(file.current)) {
    return [];
  }
  return lineSignals(
    file,
    "go-cli.interactive-no-tty",
    /\b(?:bufio\.New(?:Scanner|Reader)\(\s*os\.Stdin|fmt\.Scan(?:ln|f)?\s*\(|promptui\.|survey\.|golang\.org\/x\/term\.ReadPassword)/,
    () => "This path reads interactive input without an obvious non-TTY guard in the same file.",
  );
}

/** http.Client composites with no Timeout field. */
function httpNoTimeoutSignals(file: SourceRevision): Signal[] {
  if (isNonProductPath(file.path)) return [];
  // Single-line empty or partial client without Timeout.
  const singleLine = lineSignals(
    file,
    "go-cli.http-no-timeout",
    /&?http\.Client\{\s*\}/,
    () => "This http.Client has no Timeout field.",
  );
  // Multi-line: Client{ ... } block without Timeout: inside.
  const multi: Signal[] = [];
  const re = /&?http\.Client\{([^}]*)\}/gs;
  let match: RegExpExecArray | null;
  while ((match = re.exec(file.current)) !== null) {
    const body = match[1] ?? "";
    if (/\bTimeout\s*:/.test(body)) continue;
    if (body.trim() === "" && singleLine.length > 0) continue; // already covered
    const line = file.current.slice(0, match.index).split("\n").length;
    multi.push({
      ruleId: "go-cli.http-no-timeout",
      path: file.path,
      line,
      message: "This http.Client is constructed without an explicit Timeout.",
      snippet: match[0].replace(/\s+/g, " ").trim().slice(0, 300),
      data: {},
    });
  }
  // Dedupe by line
  const byLine = new Map<number, Signal>();
  for (const signal of [...singleLine, ...multi]) {
    byLine.set(signal.line, signal);
  }
  return [...byLine.values()];
}

/** Cobra command literals without SilenceUsage in the same file. */
function cobraSilenceUsageSignals(file: SourceRevision): Signal[] {
  if (isNonProductPath(file.path)) return [];
  if (!/\bcobra\.Command\s*\{/.test(file.current)) return [];
  if (/\bSilenceUsage\s*:/.test(file.current)) return [];
  if (!/\bUse\s*:/.test(file.current)) return [];
  return contentSignal(
    file,
    "go-cli.cobra-silence-usage",
    /\bcobra\.Command\s*\{/,
    "This Cobra command definition does not set SilenceUsage, so runtime errors may dump usage text.",
  );
}

/** Root CLI files with Cobra/urfave but no Version identity. */
function versionIdentitySignals(file: SourceRevision): Signal[] {
  if (isNonProductPath(file.path)) return [];
  const path = file.path.replaceAll("\\", "/");
  if (!/(^|\/)(main\.go|cmd\/root\.go|cli\/root\.go|internal\/(?:cmd|cli)\/root\.go)$/.test(path)) {
    return [];
  }
  const isFramework =
    /\bcobra\.Command\b/.test(file.current) ||
    /\bcli\.(?:New)?App\b/.test(file.current) ||
    /urfave\/cli/.test(file.current);
  if (!isFramework) return [];
  if (/\bVersion\s*:/.test(file.current)) return [];
  if (/\bversion\.(?:Version|String|Get|Info)\b/.test(file.current)) return [];
  if (/debug\.ReadBuildInfo\s*\(/.test(file.current)) return [];
  return contentSignal(
    file,
    "go-cli.version-identity",
    /\bcobra\.Command\b|\bcli\.(?:New)?App\b/,
    "This CLI root does not set Version or reference a version helper / ReadBuildInfo.",
  );
}

/** JSON encoded to stdout without a local format/json flag switch. */
function jsonWithoutFormatSignals(file: SourceRevision): Signal[] {
  if (isNonProductPath(file.path)) return [];
  if (
    /\b(?:format|Format)\b/.test(file.current) &&
    /json|JSON|StringVar|Flags\(\)|PersistentFlags/.test(file.current)
  ) {
    return [];
  }
  if (/\b--json\b|"json"|String\("json"/.test(file.current)) return [];
  return lineSignals(
    file,
    "go-cli.json-without-format",
    /json\.NewEncoder\(\s*os\.Stdout\b/,
    () => "JSON is encoded to os.Stdout without an obvious --format/--json switch in this file.",
  );
}

/** Bare log.Print* used for user-facing messaging (not Fatal — covered by exit-bypass). */
function bareUserLogSignals(file: SourceRevision): Signal[] {
  if (isNonProductPath(file.path)) return [];
  return lineSignals(
    file,
    "go-cli.bare-user-log",
    /\blog\.(?:Print|Printf|Println)\s*\(/,
    () => "This path uses the log package for messaging instead of explicit stdout/stderr writes.",
  );
}

/** init() blocks that construct network clients or call Must/Exit. */
function initSideEffectSignals(file: SourceRevision): Signal[] {
  if (isNonProductPath(file.path)) return [];
  if (!/\bfunc\s+init\s*\(\s*\)\s*\{/.test(file.current)) return [];
  const initBodies = file.current.matchAll(/\bfunc\s+init\s*\(\s*\)\s*\{([\s\S]*?)\n\}/g);
  const signals: Signal[] = [];
  for (const match of initBodies) {
    const body = match[1] ?? "";
    if (!/\b(?:http\.|sql\.Open|Dial|Must\(|os\.Exit|exec\.Command)/.test(body)) continue;
    const line = file.current.slice(0, match.index ?? 0).split("\n").length;
    signals.push({
      ruleId: "go-cli.init-side-effects",
      path: file.path,
      line,
      message: "Package init constructs clients or performs process/network side effects.",
      snippet: "func init() { … }",
      data: {},
    });
  }
  return signals;
}

/** os.Args reads outside main.go entry files. */
function osArgsOutsideMainSignals(file: SourceRevision): Signal[] {
  if (isNonProductPath(file.path)) return [];
  if (/(^|\/)main\.go$/.test(file.path.replaceAll("\\", "/"))) return [];
  return lineSignals(
    file,
    "go-cli.os-args-outside-main",
    /\bos\.Args\b/,
    () => "This non-main package reads os.Args directly instead of injected arguments.",
  );
}

/** Spinner/ANSI libraries without TTY guard in the same file. */
function ansiNoTtySignals(file: SourceRevision): Signal[] {
  if (isNonProductPath(file.path)) return [];
  if (/\b(?:term\.IsTerminal|isatty\.IsTerminal|IsTerminal\s*\()/.test(file.current)) {
    return [];
  }
  return lineSignals(
    file,
    "go-cli.ansi-no-tty",
    /\b(?:spinner\.|yacspin\.|briandowns\/spinner|\\033\[|\\x1b\[)/,
    () => "This path uses spinner/ANSI output without an obvious TTY guard in the same file.",
  );
}

/**
 * git/docker/kubectl Command lines with a variable positional after fixed options
 * and no `--` separator or validate helper in-file.
 */
function optionSmugglingSignals(file: SourceRevision): Signal[] {
  if (isNonProductPath(file.path)) return [];
  if (/\bvalidate(?:Rev|Ref|Arg)|rejectLeadingDash|LookPath/.test(file.current)) {
    return [];
  }
  return lineSignals(
    file,
    "go-cli.option-smuggling-risk",
    /\bexec\.Command(?:Context)?\s*\(\s*"(?:git|docker|kubectl|helm)"\s*,[^)]*\b\w+\s*\)/,
    (match) => {
      const line = match[0] ?? "";
      if (line.includes(`"--"`) || line.includes(`"--",`)) return "";
      // Require at least one string literal option and a trailing identifier arg.
      if (!/"-[-\w]/.test(line) && !/"checkout"|"run"|"exec"|"get"/.test(line)) return "";
      if (!/,\s*[a-zA-Z_]\w*\s*\)/.test(line)) return "";
      return "This subprocess passes a variable argument into git/docker/kubectl without an obvious `--` or validator.";
    },
  ).filter((signal) => signal.message !== "");
}
