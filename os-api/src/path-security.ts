import { existsSync, realpathSync } from "node:fs";
import { delimiter, isAbsolute, relative, resolve } from "node:path";

export class ForbiddenPathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ForbiddenError";
  }
}

export class PathNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NotFoundError";
  }
}

export function splitAllowedRoots(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(delimiter)
    .map((item) => item.trim())
    .filter(Boolean);
}

export function isPathInsideRoot(candidatePath: string, rootPath: string): boolean {
  const rel = relative(rootPath, candidatePath);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

export function resolveExistingRealPathInsideAllowedRoots(
  rawPath: string,
  allowedRoots: readonly string[],
  opts: {
    missingMessage?: string;
    forbiddenMessage?: string;
    missingRootMessage?: string;
  } = {},
): string {
  const candidate = resolve(rawPath);
  if (!existsSync(candidate)) {
    throw new PathNotFoundError(opts.missingMessage ?? `File not found: ${candidate}`);
  }

  const existingRoots = allowedRoots
    .map((root) => resolve(root))
    .filter((root) => existsSync(root));
  if (existingRoots.length === 0) {
    throw new PathNotFoundError(opts.missingRootMessage ?? "No configured source roots exist on disk");
  }

  const realCandidate = realpathSync(candidate);
  const realRoots = existingRoots.map((root) => realpathSync(root));
  const insideAllowedRoot = realRoots.some((root) => isPathInsideRoot(realCandidate, root));
  if (!insideAllowedRoot) {
    throw new ForbiddenPathError(opts.forbiddenMessage ?? "File is outside the configured allowed roots");
  }

  return realCandidate;
}
