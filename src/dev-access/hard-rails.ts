import path from 'path';

export interface HardRailInput {
  requestedPath: string;
  nanoclawDir: string;
  blockedPatterns: string[];
  allowedRootPaths: string[];
}

export interface HardRailResult {
  allowed: boolean;
  reason?: string;
}

function normalize(p: string): string {
  return path.normalize(p);
}

function isUnderOrEqual(child: string, parent: string): boolean {
  const c = normalize(child);
  const p = normalize(parent);
  if (c === p) return true;
  return c.startsWith(p + path.sep);
}

export function validateAccessRequest(input: HardRailInput): HardRailResult {
  const { requestedPath, nanoclawDir, blockedPatterns, allowedRootPaths } =
    input;

  // Path traversal: requested path normalises out of any allowed root
  const normalised = normalize(requestedPath);
  if (requestedPath.includes('..')) {
    if (!allowedRootPaths.some((r) => isUnderOrEqual(normalised, r))) {
      return {
        allowed: false,
        reason: `Path traversal blocked: "${requestedPath}" resolves outside any allowed root`,
      };
    }
  }

  // NanoClaw self-dir
  if (isUnderOrEqual(normalised, nanoclawDir)) {
    return {
      allowed: false,
      reason: `Cannot grant access to NanoClaw's own directory ("${nanoclawDir}") — modifying it would break the sandbox. Edit NanoClaw from your laptop directly.`,
    };
  }

  // Blocked patterns (any path component matches)
  const parts = normalised.split(path.sep);
  for (const pattern of blockedPatterns) {
    if (parts.some((part) => part === pattern || part.includes(pattern))) {
      return {
        allowed: false,
        reason: `Path matches blocked pattern "${pattern}": "${normalised}"`,
      };
    }
  }

  // Outside allowed roots
  const inRoot = allowedRootPaths.some((root) =>
    isUnderOrEqual(normalised, root),
  );
  if (!inRoot) {
    return {
      allowed: false,
      reason: `Path "${normalised}" is outside any allowed root: ${allowedRootPaths.join(', ')}`,
    };
  }

  return { allowed: true };
}
