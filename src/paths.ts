/** Normalize repository-relative paths for taste heuristics. */
export function normalizeRepoPath(path: string): string {
  return path.replaceAll("\\", "/");
}

/**
 * Dev/support trees that are not the product CLI surface. Lifecycle findings
 * there are usually noise (one-off scripts, generators, testdata).
 */
export function isNonProductPath(path: string): boolean {
  const normalized = normalizeRepoPath(path);
  return /(^|\/)(?:scripts|tools|testdata|third_party|vendor|node_modules)\//.test(
    normalized,
  );
}

/** Prefer command entrypoints and frameworks over libraries. */
export function pathPriority(path: string): number {
  const normalized = normalizeRepoPath(path);
  if (isNonProductPath(normalized)) return 100;
  if (/(^|\/)main\.go$/.test(normalized)) return 0;
  if (/(^|\/)cmd\//.test(normalized) || /(^|\/)cli\//.test(normalized)) return 1;
  if (/(^|\/)internal\/(cmd|cli|app|command)\//.test(normalized)) return 2;
  if (/(^|\/)pkg\//.test(normalized) || /(^|\/)internal\//.test(normalized)) return 4;
  return 3;
}

export function isCommandPath(path: string): boolean {
  return pathPriority(path) <= 2;
}

export function isMainPackagePath(path: string): boolean {
  return /(^|\/)main\.go$/.test(normalizeRepoPath(path));
}

/**
 * Process-boundary exit in main — correct CLI pattern, not a bypass.
 * Flag defer os.Exit and Fatal* even in main; flag any os.Exit outside main.
 */
export function isProcessBoundaryExit(snippet: string, path: string): boolean {
  if (!isMainPackagePath(path)) return false;
  if (/\bdefer\b/.test(snippet)) return false;
  if (/\bFatal/.test(snippet)) return false;
  // Any non-defer os.Exit in main is the process boundary (including os.Exit(1)).
  return /\bos\.Exit\s*\(/.test(snippet);
}

/**
 * Root signal bootstrap: signal.NotifyContext(context.Background(), ...) is how
 * CLIs create the process root context — not a cancel hole.
 */
export function isRootSignalBootstrap(snippet: string, surrounding: string): boolean {
  const compact = `${surrounding}\n${snippet}`.replace(/\s+/g, " ");
  return /signal\.NotifyContext\s*\(\s*context\.(?:Background|TODO)\s*\(\s*\)/.test(compact);
}
