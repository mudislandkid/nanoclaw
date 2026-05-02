import fs from 'fs';
import path from 'path';

import { MOUNT_ALLOWLIST_PATH } from './config.js';
import { invalidateAllowlistCache } from './mount-security.js';
import { AllowedRoot, MountAllowlist } from './types.js';

interface AddSubdirOptions {
  path: string;
  description?: string;
}

function readAllowlist(): MountAllowlist {
  if (!fs.existsSync(MOUNT_ALLOWLIST_PATH)) {
    return { allowedRoots: [], blockedPatterns: [], nonMainReadOnly: true };
  }
  const content = fs.readFileSync(MOUNT_ALLOWLIST_PATH, 'utf-8');
  return JSON.parse(content) as MountAllowlist;
}

function writeAllowlistAtomic(allowlist: MountAllowlist): void {
  const tmpPath = MOUNT_ALLOWLIST_PATH + '.tmp';
  fs.mkdirSync(path.dirname(MOUNT_ALLOWLIST_PATH), { recursive: true });
  fs.writeFileSync(tmpPath, JSON.stringify(allowlist, null, 2) + '\n');
  fs.renameSync(tmpPath, MOUNT_ALLOWLIST_PATH);
  invalidateAllowlistCache();
}

export function addSubdirEntry(opts: AddSubdirOptions): void {
  const allowlist = readAllowlist();
  const exists = allowlist.allowedRoots.some((r) => r.path === opts.path);
  if (exists) return;

  const entry: AllowedRoot = {
    path: opts.path,
    allowReadWrite: true,
    overrideNonMainReadOnly: true,
    description: opts.description,
  };
  allowlist.allowedRoots.push(entry);
  writeAllowlistAtomic(allowlist);
}

export function removeSubdirEntry(targetPath: string): void {
  const allowlist = readAllowlist();
  const before = allowlist.allowedRoots.length;
  allowlist.allowedRoots = allowlist.allowedRoots.filter(
    (r) => r.path !== targetPath,
  );
  if (allowlist.allowedRoots.length === before) return;
  writeAllowlistAtomic(allowlist);
}

export function listWritableSubdirs(rootPath: string): string[] {
  const allowlist = readAllowlist();
  return allowlist.allowedRoots
    .filter(
      (r) =>
        r.path !== rootPath &&
        r.path.startsWith(rootPath + path.sep) &&
        r.allowReadWrite === true,
    )
    .map((r) => r.path);
}
