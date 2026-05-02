# Developer Access Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give Andy view/edit access to projects on `/Volumes/1tbSSD/`, with conversational runtime control over write permissions and per-command approval for destructive Bash operations — all gated through the registered channel for the main group.

**Architecture:** Read-only root mount of `/Volumes/1tbSSD/` at `/workspace/dev/` for the main group, with per-project read-write overlays granted via Signal-mediated approval. A new `dev-access-handler.ts` module on the host watches per-group IPC directories, validates against hard rails (NanoClaw self-dir, blocked secret patterns, path traversal), prompts the user via the registered channel, and on YES mutates the mount allowlist + group config in SQLite. Mount changes apply to the next container spawn. A PreToolUse hook in the agent-runner intercepts destructive Bash commands and uses the same handler/IPC plumbing for per-command approval.

**Tech Stack:** TypeScript, Node ESM, Vitest, better-sqlite3, Claude Agent SDK PreToolUse hook, container bind-mount overlay (Docker/Apple Container).

**Spec:** `docs/superpowers/specs/2026-05-02-developer-access-design.md`

---

## File Structure

### New files (host side)
- `src/dev-access-handler.ts` — IPC watcher, classifier, prompt orchestration, allowlist/DB mutations, audit log writer
- `src/dev-access-handler.test.ts` — unit tests for classifier, queue, hard-rail validation, mutations
- `src/dangerous-commands.ts` — pattern matching, config loader, cache invalidation
- `src/dangerous-commands.test.ts` — unit tests for pattern matching
- `bin/nanoclaw-mount-reload.ts` — host CLI to invalidate mount-security and dangerous-commands caches
- `.claude/skills/add-developer-access/SKILL.md` — installer skill

### New files (container side)
- `container/skills/dev-access/SKILL.md` — Andy's prose instructions
- `container/skills/dev-access/dev-access` — bash CLI marshalling JSON IPC requests
- `container/agent-runner/src/destructive-hook.ts` — PreToolUse hook implementation

### Modified files
- `src/types.ts` — add `requireApproval` to `AllowedRoot`; add `devAccessEnabled` flag to `ContainerConfig`
- `src/mount-security.ts` — add `invalidateAllowlistCache()`; honour `requireApproval` semantics; expose helper to mutate allowlist file
- `src/container-runner.ts` — auto-add RO root mounts for `requireApproval: true` roots when group has `devAccessEnabled`
- `src/index.ts` — wire `startDevAccessHandler()` into `main()`
- `src/router.ts` — add `interceptDevAccessReply()` helper used by inbound message handling
- `container/agent-runner/src/index.ts` — register `PreToolUse` hook from `destructive-hook.ts`
- `groups/main/CLAUDE.md` — documentation section for the new `/workspace/dev/` namespace and dev-access tool (modified by install skill at deploy time, not in source tree)

### Config files (host, outside project root)
- `~/.config/nanoclaw/mount-allowlist.json` — gains SSD root entry with `requireApproval: true`
- `~/.config/nanoclaw/dangerous-commands.json` — pattern set (new file, written by install skill)
- `~/.config/nanoclaw/dev-access-rollback.sh` — written by install skill for clean uninstall

---

## Phase 1: Type and Schema Extensions

### Task 1.1: Add `requireApproval` to `AllowedRoot` type

**Files:**
- Modify: `src/types.ts`

- [ ] **Step 1: Edit `src/types.ts` to extend `AllowedRoot`**

```typescript
export interface AllowedRoot {
  path: string;
  allowReadWrite: boolean;
  overrideNonMainReadOnly?: boolean;
  // When true: root is mounted RO automatically for groups with
  // devAccessEnabled; subdirectories require their own allowlist entry
  // with allowReadWrite:true to be writable. Used by add-developer-access.
  requireApproval?: boolean;
  description?: string;
}
```

- [ ] **Step 2: Add `devAccessEnabled` flag to `ContainerConfig`**

```typescript
export interface ContainerConfig {
  additionalMounts?: AdditionalMount[];
  timeout?: number;
  // When true: orchestrator auto-mounts any allowlist root with
  // requireApproval:true at /workspace/dev/ as RO. Per-project RW
  // overlays still come from additionalMounts.
  devAccessEnabled?: boolean;
}
```

- [ ] **Step 3: Run typecheck**

Run: `npm run typecheck`
Expected: PASS (no type errors)

- [ ] **Step 4: Commit**

```bash
git add src/types.ts
git commit -m "feat(types): add requireApproval and devAccessEnabled flags

Extends AllowedRoot with requireApproval for the developer-access
feature: roots flagged this way are mounted RO automatically; RW
access is per-subdirectory and granted at runtime via Signal.

Adds devAccessEnabled to ContainerConfig so the orchestrator knows
which groups should receive the auto-RO root mount."
```

---

## Phase 2: Mount Security Extensions

### Task 2.1: Test cache invalidation

**Files:**
- Modify: `src/mount-security.test.ts`

- [ ] **Step 1: Add a failing test for cache invalidation**

Append to `src/mount-security.test.ts` (inside the existing `describe` or as a new `describe` block):

```typescript
describe('mount-security: cache invalidation', () => {
  beforeEach(() => {
    fs.mkdirSync(testDir, { recursive: true });
    fs.mkdirSync(configDir, { recursive: true });
    vi.resetModules();
    vi.doMock('./config.js', () => ({
      MOUNT_ALLOWLIST_PATH: allowlistPath,
    }));
  });

  afterEach(() => {
    fs.rmSync(testDir, { recursive: true, force: true });
    fs.rmSync(configDir, { recursive: true, force: true });
  });

  it('reloads allowlist after invalidateAllowlistCache()', async () => {
    const initial = {
      allowedRoots: [{ path: testDir, allowReadWrite: false }],
      blockedPatterns: [],
      nonMainReadOnly: true,
    };
    fs.writeFileSync(allowlistPath, JSON.stringify(initial));

    const mod = await import('./mount-security.js');
    const first = mod.loadMountAllowlist();
    expect(first?.allowedRoots[0].allowReadWrite).toBe(false);

    const updated = {
      allowedRoots: [{ path: testDir, allowReadWrite: true }],
      blockedPatterns: [],
      nonMainReadOnly: true,
    };
    fs.writeFileSync(allowlistPath, JSON.stringify(updated));

    // Without invalidation, cache should still return the old value
    const cached = mod.loadMountAllowlist();
    expect(cached?.allowedRoots[0].allowReadWrite).toBe(false);

    mod.invalidateAllowlistCache();

    const reloaded = mod.loadMountAllowlist();
    expect(reloaded?.allowedRoots[0].allowReadWrite).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/mount-security.test.ts -t "cache invalidation"`
Expected: FAIL with `mod.invalidateAllowlistCache is not a function`

- [ ] **Step 3: Add `invalidateAllowlistCache` to `src/mount-security.ts`**

Add near the top (after the cache variables):

```typescript
/**
 * Invalidate the cached allowlist so the next call to loadMountAllowlist()
 * re-reads from disk. Used by dev-access-handler after grants/revokes,
 * and by the nanoclaw-mount-reload CLI for manual hot-reload.
 */
export function invalidateAllowlistCache(): void {
  cachedAllowlist = null;
  allowlistLoadError = null;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/mount-security.test.ts -t "cache invalidation"`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/mount-security.ts src/mount-security.test.ts
git commit -m "feat(mount-security): add invalidateAllowlistCache()

Allows the dev-access handler to hot-reload the allowlist after
mutations without restarting NanoClaw. The cached allowlist would
otherwise stick around for the lifetime of the process."
```

---

### Task 2.2: Test `requireApproval` semantics

**Files:**
- Modify: `src/mount-security.test.ts`

- [ ] **Step 1: Add tests for `requireApproval` validation behaviour**

Append to `src/mount-security.test.ts`:

```typescript
describe('mount-security: requireApproval roots', () => {
  beforeEach(() => {
    fs.mkdirSync(testDir, { recursive: true });
    fs.mkdirSync(configDir, { recursive: true });
    vi.resetModules();
    vi.doMock('./config.js', () => ({
      MOUNT_ALLOWLIST_PATH: allowlistPath,
    }));
  });

  afterEach(() => {
    fs.rmSync(testDir, { recursive: true, force: true });
    fs.rmSync(configDir, { recursive: true, force: true });
  });

  it('forces root with requireApproval:true to read-only', async () => {
    const allowlist = {
      allowedRoots: [
        {
          path: testDir,
          allowReadWrite: true,
          requireApproval: true,
        },
      ],
      blockedPatterns: [],
      nonMainReadOnly: false,
    };
    fs.writeFileSync(allowlistPath, JSON.stringify(allowlist));

    const mod = await import('./mount-security.js');
    // Even though allowReadWrite:true, the root itself is RO when
    // requireApproval is set — only explicit child entries can be RW.
    const result = mod.validateMount(
      { hostPath: testDir, containerPath: 'dev', readonly: false },
      true,
    );

    expect(result.allowed).toBe(true);
    expect(result.effectiveReadonly).toBe(true);
  });

  it('allows RW for subdirectory with its own allowlist entry under a requireApproval root', async () => {
    const subDir = path.join(testDir, 'VoltWise');
    fs.mkdirSync(subDir, { recursive: true });

    const allowlist = {
      allowedRoots: [
        { path: testDir, allowReadWrite: false, requireApproval: true },
        { path: subDir, allowReadWrite: true, overrideNonMainReadOnly: true },
      ],
      blockedPatterns: [],
      nonMainReadOnly: true,
    };
    fs.writeFileSync(allowlistPath, JSON.stringify(allowlist));

    const mod = await import('./mount-security.js');
    const result = mod.validateMount(
      { hostPath: subDir, containerPath: 'VoltWise', readonly: false },
      true,
    );

    expect(result.allowed).toBe(true);
    expect(result.effectiveReadonly).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/mount-security.test.ts -t "requireApproval"`
Expected: FAIL — first test fails because the root with `allowReadWrite:true` will currently let the mount go RW.

- [ ] **Step 3: Implement `requireApproval` enforcement**

In `src/mount-security.ts`, modify `validateMount` to override `effectiveReadonly` when the matched allowed root has `requireApproval:true` AND the resolved real path equals the root itself (not a subdirectory):

Find the section that computes `effectiveReadonly` and add a clause. The block currently looks like:

```typescript
  if (requestedReadWrite) {
    if (
      !isMain &&
      allowlist.nonMainReadOnly &&
      !allowedRoot.overrideNonMainReadOnly
    ) {
      effectiveReadonly = true;
      ...
```

Replace the `if (requestedReadWrite) { ... }` block with:

```typescript
  if (requestedReadWrite) {
    // requireApproval: when the request is for the root itself (not a
    // subdirectory entry), force RO. RW only via explicit subdir entries.
    const expandedRoot = expandPath(allowedRoot.path);
    const realRoot = getRealPath(expandedRoot);
    const isRootItself = realRoot !== null && realRoot === realPath;
    if (allowedRoot.requireApproval && isRootItself) {
      effectiveReadonly = true;
      logger.info(
        { mount: mount.hostPath, root: allowedRoot.path },
        'Mount forced to read-only — requireApproval root',
      );
    } else if (
      !isMain &&
      allowlist.nonMainReadOnly &&
      !allowedRoot.overrideNonMainReadOnly
    ) {
      effectiveReadonly = true;
      logger.info(
        { mount: mount.hostPath },
        'Mount forced to read-only for non-main group',
      );
    } else if (!allowedRoot.allowReadWrite) {
      effectiveReadonly = true;
      logger.info(
        { mount: mount.hostPath, root: allowedRoot.path },
        'Mount forced to read-only - root does not allow read-write',
      );
    } else {
      effectiveReadonly = false;
    }
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/mount-security.test.ts`
Expected: PASS — all `requireApproval` tests, plus existing `overrideNonMainReadOnly` and cache tests still green.

- [ ] **Step 5: Commit**

```bash
git add src/mount-security.ts src/mount-security.test.ts
git commit -m "feat(mount-security): honour requireApproval flag on roots

Roots flagged requireApproval:true are mounted RO regardless of
allowReadWrite — RW access is granted per-subdirectory through
explicit child entries. This is the security primitive used by
the developer-access feature."
```

---

### Task 2.3: Allowlist mutation helpers (atomic add/remove subdir entries)

**Files:**
- Create: `src/allowlist-writer.ts`
- Create: `src/allowlist-writer.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/allowlist-writer.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

const configDir = path.join(os.tmpdir(), 'nanoclaw-allowlist-writer-test');
const allowlistPath = path.join(configDir, 'mount-allowlist.json');

vi.mock('./config.js', () => ({
  MOUNT_ALLOWLIST_PATH: allowlistPath,
}));

describe('allowlist-writer', () => {
  beforeEach(() => {
    fs.mkdirSync(configDir, { recursive: true });
    vi.resetModules();
    vi.doMock('./config.js', () => ({
      MOUNT_ALLOWLIST_PATH: allowlistPath,
    }));
  });

  afterEach(() => {
    fs.rmSync(configDir, { recursive: true, force: true });
  });

  it('adds a subdirectory entry preserving existing roots', async () => {
    const initial = {
      allowedRoots: [
        { path: '/Volumes/1tbSSD', allowReadWrite: false, requireApproval: true },
      ],
      blockedPatterns: [],
      nonMainReadOnly: true,
    };
    fs.writeFileSync(allowlistPath, JSON.stringify(initial));

    const mod = await import('./allowlist-writer.js');
    mod.addSubdirEntry({
      path: '/Volumes/1tbSSD/VoltWise',
      description: 'Granted via dev-access on 2026-05-02',
    });

    const updated = JSON.parse(fs.readFileSync(allowlistPath, 'utf-8'));
    expect(updated.allowedRoots).toHaveLength(2);
    expect(updated.allowedRoots[0].path).toBe('/Volumes/1tbSSD');
    expect(updated.allowedRoots[1]).toMatchObject({
      path: '/Volumes/1tbSSD/VoltWise',
      allowReadWrite: true,
      overrideNonMainReadOnly: true,
    });
  });

  it('is idempotent — adding an existing entry does not duplicate', async () => {
    const initial = {
      allowedRoots: [
        { path: '/Volumes/1tbSSD/VoltWise', allowReadWrite: true, overrideNonMainReadOnly: true },
      ],
      blockedPatterns: [],
      nonMainReadOnly: true,
    };
    fs.writeFileSync(allowlistPath, JSON.stringify(initial));

    const mod = await import('./allowlist-writer.js');
    mod.addSubdirEntry({ path: '/Volumes/1tbSSD/VoltWise' });

    const updated = JSON.parse(fs.readFileSync(allowlistPath, 'utf-8'));
    expect(updated.allowedRoots).toHaveLength(1);
  });

  it('removes a subdirectory entry by path', async () => {
    const initial = {
      allowedRoots: [
        { path: '/Volumes/1tbSSD', allowReadWrite: false, requireApproval: true },
        { path: '/Volumes/1tbSSD/VoltWise', allowReadWrite: true, overrideNonMainReadOnly: true },
      ],
      blockedPatterns: [],
      nonMainReadOnly: true,
    };
    fs.writeFileSync(allowlistPath, JSON.stringify(initial));

    const mod = await import('./allowlist-writer.js');
    mod.removeSubdirEntry('/Volumes/1tbSSD/VoltWise');

    const updated = JSON.parse(fs.readFileSync(allowlistPath, 'utf-8'));
    expect(updated.allowedRoots).toHaveLength(1);
    expect(updated.allowedRoots[0].path).toBe('/Volumes/1tbSSD');
  });

  it('atomic write: leaves no partial file on failure', async () => {
    const initial = {
      allowedRoots: [{ path: '/Volumes/1tbSSD', allowReadWrite: false, requireApproval: true }],
      blockedPatterns: [],
      nonMainReadOnly: true,
    };
    fs.writeFileSync(allowlistPath, JSON.stringify(initial));

    const mod = await import('./allowlist-writer.js');
    mod.addSubdirEntry({ path: '/Volumes/1tbSSD/X' });

    // No .tmp file should remain
    const tmpFile = allowlistPath + '.tmp';
    expect(fs.existsSync(tmpFile)).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/allowlist-writer.test.ts`
Expected: FAIL with module-not-found

- [ ] **Step 3: Implement `src/allowlist-writer.ts`**

```typescript
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/allowlist-writer.test.ts`
Expected: PASS (all four tests)

- [ ] **Step 5: Commit**

```bash
git add src/allowlist-writer.ts src/allowlist-writer.test.ts
git commit -m "feat(allowlist-writer): atomic add/remove of subdir entries

Provides addSubdirEntry / removeSubdirEntry / listWritableSubdirs
helpers that the dev-access handler will use to mutate the mount
allowlist after grants and revokes. Writes go through a temp file
+ rename for atomicity, and invalidate the mount-security cache
on success so the next container spawn sees the change."
```

---

## Phase 3: Container Runner — Auto RO Root Mount

### Task 3.1: Test that `devAccessEnabled` adds RO root mount

**Files:**
- Modify: `src/container-runner.test.ts`

- [ ] **Step 1: Read the existing container-runner.test.ts to understand test patterns**

Run: `cat src/container-runner.test.ts`

- [ ] **Step 2: Add a failing test for the auto RO mount**

Append to `src/container-runner.test.ts` (using existing imports and helpers — match the surrounding test style):

```typescript
describe('container-runner: devAccessEnabled auto RO root mount', () => {
  // The exact test will depend on how container-runner exposes
  // mount construction. If there's an existing buildVolumeMounts
  // export-for-testing, use that. Otherwise add one in the next step.

  it('adds RO root mount for each requireApproval allowlist root when devAccessEnabled', async () => {
    // Mock allowlist with /tmp/test-dev as a requireApproval root
    // Mock group with containerConfig.devAccessEnabled = true
    // Call buildVolumeMounts (or equivalent test entry point)
    // Assert /tmp/test-dev → /workspace/dev (readonly: true) is present
  });

  it('does not add the auto RO mount when devAccessEnabled is false', async () => {
    // Same setup but devAccessEnabled = false
    // Assert no /workspace/dev mount in result
  });
});
```

Filling in the implementation depends on the existing test conventions in this file. If `buildVolumeMounts` is not exported, export it for testing (`/** @internal */`) before writing the assertions.

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx vitest run src/container-runner.test.ts -t "devAccessEnabled"`
Expected: FAIL

- [ ] **Step 4: Implement the auto RO root mount in `src/container-runner.ts`**

In `buildVolumeMounts`, after the existing main/non-main mount blocks but before the `additionalMounts` validation, add:

```typescript
  // Auto-mount requireApproval roots for groups with devAccessEnabled.
  // The root itself is RO; per-project RW overlays come from additionalMounts.
  if (group.containerConfig?.devAccessEnabled) {
    const allowlist = loadMountAllowlist();
    if (allowlist) {
      for (const root of allowlist.allowedRoots) {
        if (!root.requireApproval) continue;
        const expanded = root.path.startsWith('~')
          ? path.join(
              process.env.HOME || os.homedir(),
              root.path.slice(2),
            )
          : root.path;
        if (!fs.existsSync(expanded)) continue;
        mounts.push({
          hostPath: expanded,
          containerPath: '/workspace/dev',
          readonly: true,
        });
      }
    }
  }
```

(Add `import os from 'os';` and `import { loadMountAllowlist } from './mount-security.js';` at the top if not present.)

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run src/container-runner.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/container-runner.ts src/container-runner.test.ts
git commit -m "feat(container-runner): auto-mount requireApproval roots

Groups flagged with containerConfig.devAccessEnabled receive a
read-only mount of every allowlist root with requireApproval:true,
landing at /workspace/dev/. This is the read-only base for the
developer-access feature; per-project RW overlays come from the
group's additionalMounts."
```

---

## Phase 4: Affirmative/Negative Classifier

### Task 4.1: Reply classifier

**Files:**
- Create: `src/dev-access/reply-classifier.ts`
- Create: `src/dev-access/reply-classifier.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/dev-access/reply-classifier.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { classifyReply } from './reply-classifier.js';

describe('classifyReply', () => {
  it('matches simple affirmatives', () => {
    expect(classifyReply('yes').decision).toBe('affirmative');
    expect(classifyReply('Yes').decision).toBe('affirmative');
    expect(classifyReply('YEAH').decision).toBe('affirmative');
    expect(classifyReply('yep').decision).toBe('affirmative');
    expect(classifyReply('sure').decision).toBe('affirmative');
    expect(classifyReply('ok').decision).toBe('affirmative');
    expect(classifyReply('okay').decision).toBe('affirmative');
    expect(classifyReply('do it').decision).toBe('affirmative');
    expect(classifyReply('go ahead').decision).toBe('affirmative');
    expect(classifyReply('grant').decision).toBe('affirmative');
    expect(classifyReply('allow').decision).toBe('affirmative');
    expect(classifyReply('👍').decision).toBe('affirmative');
  });

  it('matches simple negatives', () => {
    expect(classifyReply('no').decision).toBe('negative');
    expect(classifyReply('No').decision).toBe('negative');
    expect(classifyReply('NOPE').decision).toBe('negative');
    expect(classifyReply('nah').decision).toBe('negative');
    expect(classifyReply("don't").decision).toBe('negative');
    expect(classifyReply('dont').decision).toBe('negative');
    expect(classifyReply('deny').decision).toBe('negative');
    expect(classifyReply('reject').decision).toBe('negative');
    expect(classifyReply('👎').decision).toBe('negative');
  });

  it('returns none for non-matching messages', () => {
    expect(classifyReply('actually fix Y first').decision).toBe('none');
    expect(classifyReply('what does VoltWise do?').decision).toBe('none');
    expect(classifyReply('').decision).toBe('none');
  });

  it('extracts a project disambiguator if present', () => {
    expect(classifyReply('yes VoltWise')).toEqual({
      decision: 'affirmative',
      project: 'VoltWise',
    });
    expect(classifyReply('no Eirene')).toEqual({
      decision: 'negative',
      project: 'Eirene',
    });
  });

  it('matches affirmative only at the start of the message', () => {
    expect(classifyReply('I think no').decision).toBe('none');
    expect(classifyReply('say yes to him').decision).toBe('none');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `mkdir -p src/dev-access && npx vitest run src/dev-access/reply-classifier.test.ts`
Expected: FAIL with module-not-found

- [ ] **Step 3: Implement `src/dev-access/reply-classifier.ts`**

```typescript
const AFFIRMATIVE_RE =
  /^\s*(yes|yeah|yep|sure|ok|okay|do it|go ahead|go|grant|allow|approve|👍)\b/i;
const NEGATIVE_RE =
  /^\s*(no|nope|nah|deny|don'?t|reject|👎)\b/i;

export type ReplyDecision = 'affirmative' | 'negative' | 'none';

export interface ClassifiedReply {
  decision: ReplyDecision;
  project?: string;
}

export function classifyReply(text: string): ClassifiedReply {
  const trimmed = text.trim();
  if (!trimmed) return { decision: 'none' };

  let decision: ReplyDecision = 'none';
  let match: RegExpMatchArray | null = null;

  match = trimmed.match(AFFIRMATIVE_RE);
  if (match) {
    decision = 'affirmative';
  } else {
    match = trimmed.match(NEGATIVE_RE);
    if (match) decision = 'negative';
  }

  if (decision === 'none') return { decision };

  // Look for a trailing project name after the keyword
  const remainder = trimmed.slice(match![0].length).trim();
  if (remainder) {
    const projectMatch = remainder.match(/^([A-Za-z0-9_-]+)/);
    if (projectMatch) {
      return { decision, project: projectMatch[1] };
    }
  }
  return { decision };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/dev-access/reply-classifier.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/dev-access/reply-classifier.ts src/dev-access/reply-classifier.test.ts
git commit -m "feat(dev-access): add reply classifier for grant/deny replies

Recognises plain yes/no/sure/nope/etc plus an optional trailing
project name for disambiguating multiple pending requests. Used
by the dev-access handler to intercept Greg's replies before they
reach Andy."
```

---

## Phase 5: Pending Request Queue

### Task 5.1: FIFO pending-request queue

**Files:**
- Create: `src/dev-access/pending-queue.ts`
- Create: `src/dev-access/pending-queue.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/dev-access/pending-queue.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import { PendingQueue, PendingRequest } from './pending-queue.js';

const baseRequest = (over: Partial<PendingRequest> = {}): PendingRequest => ({
  id: 'r1',
  groupFolder: 'main',
  command: 'request',
  project: 'VoltWise',
  reason: 'fix bug',
  requestedAt: '2026-05-02T10:00:00Z',
  ...over,
});

describe('PendingQueue', () => {
  let queue: PendingQueue;

  beforeEach(() => {
    queue = new PendingQueue();
  });

  it('enqueues and dequeues FIFO per group', () => {
    queue.add(baseRequest({ id: 'r1', project: 'A' }));
    queue.add(baseRequest({ id: 'r2', project: 'B' }));
    expect(queue.peekOldest('main')?.id).toBe('r1');
  });

  it('resolves and removes the oldest', () => {
    queue.add(baseRequest({ id: 'r1', project: 'A' }));
    queue.add(baseRequest({ id: 'r2', project: 'B' }));
    const resolved = queue.resolveOldest('main');
    expect(resolved?.id).toBe('r1');
    expect(queue.peekOldest('main')?.id).toBe('r2');
  });

  it('resolves by project name when disambiguated', () => {
    queue.add(baseRequest({ id: 'r1', project: 'VoltWise' }));
    queue.add(baseRequest({ id: 'r2', project: 'Eirene' }));
    const resolved = queue.resolveByProject('main', 'Eirene');
    expect(resolved?.id).toBe('r2');
    expect(queue.peekOldest('main')?.id).toBe('r1');
  });

  it('returns null when no requests exist for the group', () => {
    expect(queue.peekOldest('main')).toBeNull();
    expect(queue.resolveOldest('main')).toBeNull();
  });

  it('lists all pending requests for a group', () => {
    queue.add(baseRequest({ id: 'r1', project: 'A' }));
    queue.add(baseRequest({ id: 'r2', project: 'B' }));
    expect(queue.list('main').map((r) => r.id)).toEqual(['r1', 'r2']);
  });

  it('expires requests older than maxAgeMs', () => {
    const now = Date.now();
    const old = new Date(now - 10 * 60 * 1000).toISOString();
    const fresh = new Date(now - 1 * 60 * 1000).toISOString();
    queue.add(baseRequest({ id: 'r-old', requestedAt: old }));
    queue.add(baseRequest({ id: 'r-fresh', requestedAt: fresh }));
    const expired = queue.expireOlderThan(now - 5 * 60 * 1000);
    expect(expired.map((r) => r.id)).toEqual(['r-old']);
    expect(queue.list('main').map((r) => r.id)).toEqual(['r-fresh']);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/dev-access/pending-queue.test.ts`
Expected: FAIL with module-not-found

- [ ] **Step 3: Implement `src/dev-access/pending-queue.ts`**

```typescript
export type PendingCommand = 'request' | 'revoke' | 'clone';

export interface PendingRequest {
  id: string;
  groupFolder: string;
  command: PendingCommand;
  project?: string;
  owner?: string;
  reason?: string;
  requestedAt: string; // ISO
  // For dangerous-command requests these fields are populated instead:
  fullCommand?: string;
  cwd?: string;
}

export class PendingQueue {
  private byGroup = new Map<string, PendingRequest[]>();

  add(req: PendingRequest): void {
    const list = this.byGroup.get(req.groupFolder) ?? [];
    list.push(req);
    this.byGroup.set(req.groupFolder, list);
  }

  peekOldest(groupFolder: string): PendingRequest | null {
    const list = this.byGroup.get(groupFolder);
    return list && list.length > 0 ? list[0] : null;
  }

  resolveOldest(groupFolder: string): PendingRequest | null {
    const list = this.byGroup.get(groupFolder);
    if (!list || list.length === 0) return null;
    return list.shift() ?? null;
  }

  resolveByProject(
    groupFolder: string,
    project: string,
  ): PendingRequest | null {
    const list = this.byGroup.get(groupFolder);
    if (!list) return null;
    const idx = list.findIndex((r) => r.project === project);
    if (idx === -1) return null;
    const [resolved] = list.splice(idx, 1);
    return resolved;
  }

  resolveById(groupFolder: string, id: string): PendingRequest | null {
    const list = this.byGroup.get(groupFolder);
    if (!list) return null;
    const idx = list.findIndex((r) => r.id === id);
    if (idx === -1) return null;
    const [resolved] = list.splice(idx, 1);
    return resolved;
  }

  list(groupFolder: string): PendingRequest[] {
    return [...(this.byGroup.get(groupFolder) ?? [])];
  }

  /**
   * Remove requests requested before the cutoff timestamp.
   * Returns the removed entries so the caller can write timeout responses.
   */
  expireOlderThan(cutoffMs: number): PendingRequest[] {
    const expired: PendingRequest[] = [];
    for (const [group, list] of this.byGroup.entries()) {
      const remaining: PendingRequest[] = [];
      for (const r of list) {
        if (Date.parse(r.requestedAt) < cutoffMs) {
          expired.push(r);
        } else {
          remaining.push(r);
        }
      }
      this.byGroup.set(group, remaining);
    }
    return expired;
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/dev-access/pending-queue.test.ts`
Expected: PASS (all six tests)

- [ ] **Step 5: Commit**

```bash
git add src/dev-access/pending-queue.ts src/dev-access/pending-queue.test.ts
git commit -m "feat(dev-access): FIFO pending-request queue per group

Used to track outstanding access-grant and dangerous-command
prompts while waiting on Greg's reply. Supports oldest-wins,
project-disambiguated resolution, and TTL-based expiry."
```

---

## Phase 6: Hard-Rail Validation

### Task 6.1: Hard-rail validator

**Files:**
- Create: `src/dev-access/hard-rails.ts`
- Create: `src/dev-access/hard-rails.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/dev-access/hard-rails.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import path from 'path';
import { validateAccessRequest } from './hard-rails.js';

const NANOCLAW_DIR = '/Volumes/1tbSSD/nanoclaw';

describe('validateAccessRequest', () => {
  it('blocks the NanoClaw self-dir', () => {
    const result = validateAccessRequest({
      requestedPath: NANOCLAW_DIR,
      nanoclawDir: NANOCLAW_DIR,
      blockedPatterns: ['.ssh', '.env'],
      allowedRootPaths: ['/Volumes/1tbSSD'],
    });
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/nanoclaw/i);
  });

  it('blocks subpaths inside NanoClaw self-dir', () => {
    const result = validateAccessRequest({
      requestedPath: path.join(NANOCLAW_DIR, 'src'),
      nanoclawDir: NANOCLAW_DIR,
      blockedPatterns: [],
      allowedRootPaths: ['/Volumes/1tbSSD'],
    });
    expect(result.allowed).toBe(false);
  });

  it('blocks paths matching a default secret pattern', () => {
    const result = validateAccessRequest({
      requestedPath: '/Volumes/1tbSSD/MyProj/.ssh',
      nanoclawDir: NANOCLAW_DIR,
      blockedPatterns: ['.ssh'],
      allowedRootPaths: ['/Volumes/1tbSSD'],
    });
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/blocked pattern/i);
  });

  it('blocks path traversal attempts', () => {
    const result = validateAccessRequest({
      requestedPath: '/Volumes/1tbSSD/MyProj/../../etc',
      nanoclawDir: NANOCLAW_DIR,
      blockedPatterns: [],
      allowedRootPaths: ['/Volumes/1tbSSD'],
    });
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/traversal|outside/i);
  });

  it('blocks paths outside any allowed root', () => {
    const result = validateAccessRequest({
      requestedPath: '/etc/passwd',
      nanoclawDir: NANOCLAW_DIR,
      blockedPatterns: [],
      allowedRootPaths: ['/Volumes/1tbSSD'],
    });
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/outside.*allowed root/i);
  });

  it('allows a normal project inside the allowed root', () => {
    const result = validateAccessRequest({
      requestedPath: '/Volumes/1tbSSD/VoltWise',
      nanoclawDir: NANOCLAW_DIR,
      blockedPatterns: ['.ssh', '.env'],
      allowedRootPaths: ['/Volumes/1tbSSD'],
    });
    expect(result.allowed).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/dev-access/hard-rails.test.ts`
Expected: FAIL with module-not-found

- [ ] **Step 3: Implement `src/dev-access/hard-rails.ts`**

```typescript
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
  const inRoot = allowedRootPaths.some((root) => isUnderOrEqual(normalised, root));
  if (!inRoot) {
    return {
      allowed: false,
      reason: `Path "${normalised}" is outside any allowed root: ${allowedRootPaths.join(', ')}`,
    };
  }

  return { allowed: true };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/dev-access/hard-rails.test.ts`
Expected: PASS (all six tests)

- [ ] **Step 5: Commit**

```bash
git add src/dev-access/hard-rails.ts src/dev-access/hard-rails.test.ts
git commit -m "feat(dev-access): hard-rail validator for access requests

Pure validation against NanoClaw self-dir, blocked secret patterns,
path traversal, and allowed-root membership. Used by the handler
before any channel prompt is sent — auto-blocks unsafe requests."
```

---

## Phase 7: Audit Log

### Task 7.1: Append-only audit log writer

**Files:**
- Create: `src/dev-access/audit-log.ts`
- Create: `src/dev-access/audit-log.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/dev-access/audit-log.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { appendAuditEntry } from './audit-log.js';

const tmpDir = path.join(os.tmpdir(), 'nanoclaw-audit-test');
const logFile = path.join(tmpDir, 'dev-access.log');

describe('appendAuditEntry', () => {
  beforeEach(() => {
    fs.mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('writes a single line per entry', () => {
    appendAuditEntry(logFile, {
      timestamp: '2026-05-02T10:30:00Z',
      action: 'grant',
      project: 'VoltWise',
      source: 'signal-reply',
      details: { reason: 'fix bug' },
    });
    const content = fs.readFileSync(logFile, 'utf-8');
    expect(content.split('\n').filter(Boolean)).toHaveLength(1);
  });

  it('appends without overwriting prior entries', () => {
    appendAuditEntry(logFile, {
      timestamp: '2026-05-02T10:30:00Z',
      action: 'grant',
      project: 'VoltWise',
      source: 'signal-reply',
    });
    appendAuditEntry(logFile, {
      timestamp: '2026-05-02T11:00:00Z',
      action: 'revoke',
      project: 'VoltWise',
      source: 'signal-reply',
    });
    const lines = fs
      .readFileSync(logFile, 'utf-8')
      .split('\n')
      .filter(Boolean);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('grant');
    expect(lines[1]).toContain('revoke');
  });

  it('creates parent directory if missing', () => {
    const nested = path.join(tmpDir, 'nested', 'subdir', 'log.log');
    appendAuditEntry(nested, {
      timestamp: '2026-05-02T10:30:00Z',
      action: 'grant',
      project: 'X',
      source: 'manual-edit',
    });
    expect(fs.existsSync(nested)).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/dev-access/audit-log.test.ts`
Expected: FAIL with module-not-found

- [ ] **Step 3: Implement `src/dev-access/audit-log.ts`**

```typescript
import fs from 'fs';
import path from 'path';

export type AuditAction =
  | 'grant'
  | 'revoke'
  | 'clone'
  | 'request-blocked'
  | 'timeout'
  | 'dangerous-approved'
  | 'dangerous-denied'
  | 'dangerous-blocked';

export type AuditSource =
  | 'signal-reply'
  | 'manual-edit'
  | 'auto-block'
  | 'timeout';

export interface AuditEntry {
  timestamp: string;
  action: AuditAction;
  project?: string;
  source: AuditSource;
  details?: Record<string, unknown>;
}

export function appendAuditEntry(filePath: string, entry: AuditEntry): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const line = JSON.stringify(entry) + '\n';
  fs.appendFileSync(filePath, line, { encoding: 'utf-8' });
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/dev-access/audit-log.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/dev-access/audit-log.ts src/dev-access/audit-log.test.ts
git commit -m "feat(dev-access): append-only audit log writer

JSON-line entries to groups/<group>/dev-access.log and
groups/<group>/dangerous-commands.log. One line per event for
easy tail/grep auditing of grants, revokes, clones, and gated
destructive commands."
```

---

## Phase 8: Dangerous-Commands Pattern Engine

### Task 8.1: Pattern matcher with hardDeny short-circuit

**Files:**
- Create: `src/dangerous-commands.ts`
- Create: `src/dangerous-commands.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/dangerous-commands.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

const configDir = path.join(os.tmpdir(), 'nanoclaw-dangerous-test');
const configPath = path.join(configDir, 'dangerous-commands.json');

vi.mock('./config.js', () => ({
  DANGEROUS_COMMANDS_PATH: configPath,
}));

const writeConfig = (cfg: object) => {
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify(cfg));
};

describe('dangerous-commands', () => {
  beforeEach(() => {
    fs.mkdirSync(configDir, { recursive: true });
    vi.resetModules();
    vi.doMock('./config.js', () => ({ DANGEROUS_COMMANDS_PATH: configPath }));
  });

  afterEach(() => {
    fs.rmSync(configDir, { recursive: true, force: true });
  });

  it('returns "ask" for a pattern in patterns[]', async () => {
    writeConfig({
      patterns: ['rm\\s+(-[a-zA-Z]*[rRf][a-zA-Z]*\\s+|--force\\s+|--recursive\\s+)'],
      hardDenyPatterns: [],
    });
    const mod = await import('./dangerous-commands.js');
    expect(mod.evaluateCommand('rm -rf .next/').decision).toBe('ask');
  });

  it('returns "deny" for a pattern in hardDenyPatterns[]', async () => {
    writeConfig({
      patterns: [],
      hardDenyPatterns: ['rm\\s+(-[rRf]+\\s+)?/\\s*$'],
    });
    const mod = await import('./dangerous-commands.js');
    expect(mod.evaluateCommand('rm -rf /').decision).toBe('deny');
  });

  it('hardDeny takes precedence over ask', async () => {
    writeConfig({
      patterns: ['rm\\s+'],
      hardDenyPatterns: ['rm\\s+(-[rRf]+\\s+)?/\\s*$'],
    });
    const mod = await import('./dangerous-commands.js');
    expect(mod.evaluateCommand('rm -rf /').decision).toBe('deny');
  });

  it('returns "allow" for non-matching commands', async () => {
    writeConfig({
      patterns: ['rm\\s+'],
      hardDenyPatterns: [],
    });
    const mod = await import('./dangerous-commands.js');
    expect(mod.evaluateCommand('ls -la').decision).toBe('allow');
  });

  it('matches git push --force', async () => {
    writeConfig({
      patterns: ['git\\s+push\\s+.*(--force(-with-lease)?|-f\\b)'],
      hardDenyPatterns: [],
    });
    const mod = await import('./dangerous-commands.js');
    expect(mod.evaluateCommand('git push --force origin main').decision).toBe(
      'ask',
    );
    expect(mod.evaluateCommand('git push -f origin main').decision).toBe('ask');
    expect(mod.evaluateCommand('git push origin main').decision).toBe('allow');
  });

  it('reloads after invalidation', async () => {
    writeConfig({ patterns: [], hardDenyPatterns: [] });
    const mod = await import('./dangerous-commands.js');
    expect(mod.evaluateCommand('rm -rf x').decision).toBe('allow');

    writeConfig({ patterns: ['rm\\s+'], hardDenyPatterns: [] });
    expect(mod.evaluateCommand('rm -rf x').decision).toBe('allow'); // still cached
    mod.invalidateDangerousCommandsCache();
    expect(mod.evaluateCommand('rm -rf x').decision).toBe('ask');
  });
});
```

- [ ] **Step 2: Add `DANGEROUS_COMMANDS_PATH` to `src/config.ts`**

Add to `src/config.ts` (next to `MOUNT_ALLOWLIST_PATH`):

```typescript
export const DANGEROUS_COMMANDS_PATH = path.join(
  HOME_DIR,
  '.config',
  'nanoclaw',
  'dangerous-commands.json',
);
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run src/dangerous-commands.test.ts`
Expected: FAIL with module-not-found

- [ ] **Step 4: Implement `src/dangerous-commands.ts`**

```typescript
import fs from 'fs';

import { DANGEROUS_COMMANDS_PATH } from './config.js';
import { logger } from './logger.js';

export interface DangerousCommandsConfig {
  patterns: string[];
  hardDenyPatterns: string[];
}

export type DangerDecision = 'allow' | 'ask' | 'deny';

export interface DangerEvaluation {
  decision: DangerDecision;
  matchedPattern?: string;
}

let cached: { patterns: RegExp[]; hardDeny: RegExp[] } | null = null;

function loadConfig(): { patterns: RegExp[]; hardDeny: RegExp[] } {
  if (cached) return cached;
  if (!fs.existsSync(DANGEROUS_COMMANDS_PATH)) {
    logger.warn(
      { path: DANGEROUS_COMMANDS_PATH },
      'dangerous-commands.json missing — gate disabled (all commands allowed)',
    );
    cached = { patterns: [], hardDeny: [] };
    return cached;
  }
  try {
    const cfg = JSON.parse(
      fs.readFileSync(DANGEROUS_COMMANDS_PATH, 'utf-8'),
    ) as DangerousCommandsConfig;
    cached = {
      patterns: (cfg.patterns ?? []).map((p) => new RegExp(p, 'i')),
      hardDeny: (cfg.hardDenyPatterns ?? []).map((p) => new RegExp(p, 'i')),
    };
    return cached;
  } catch (err) {
    logger.error(
      { err, path: DANGEROUS_COMMANDS_PATH },
      'Failed to parse dangerous-commands.json — gate disabled',
    );
    cached = { patterns: [], hardDeny: [] };
    return cached;
  }
}

export function invalidateDangerousCommandsCache(): void {
  cached = null;
}

export function evaluateCommand(command: string): DangerEvaluation {
  const cfg = loadConfig();
  for (const re of cfg.hardDeny) {
    if (re.test(command)) {
      return { decision: 'deny', matchedPattern: re.source };
    }
  }
  for (const re of cfg.patterns) {
    if (re.test(command)) {
      return { decision: 'ask', matchedPattern: re.source };
    }
  }
  return { decision: 'allow' };
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run src/dangerous-commands.test.ts`
Expected: PASS (all six tests)

- [ ] **Step 6: Commit**

```bash
git add src/config.ts src/dangerous-commands.ts src/dangerous-commands.test.ts
git commit -m "feat(dangerous-commands): pattern engine with hardDeny

Loads regex pattern set from ~/.config/nanoclaw/dangerous-commands.json
and exposes evaluateCommand() that returns allow/ask/deny. hardDeny
patterns short-circuit before ask patterns so rm -rf / never prompts.
Cache invalidation supports the nanoclaw-mount-reload CLI for
hot-reloading both pattern files in one call."
```

---

## Phase 9: dev-access Handler Skeleton + IPC Watcher

### Task 9.1: Handler scaffolding with deps interface

**Files:**
- Create: `src/dev-access-handler.ts`
- Create: `src/dev-access-handler.test.ts`

- [ ] **Step 1: Write the failing test (validates wiring of pieces)**

Create `src/dev-access-handler.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

const tmpRoot = path.join(os.tmpdir(), 'nanoclaw-dev-access-handler-test');
const ipcDir = path.join(tmpRoot, 'data', 'ipc', 'main');
const groupsDir = path.join(tmpRoot, 'groups');
const allowlistPath = path.join(tmpRoot, 'config', 'mount-allowlist.json');
const sentMessages: Array<{ jid: string; text: string }> = [];

vi.mock('./config.js', () => ({
  MOUNT_ALLOWLIST_PATH: allowlistPath,
  DATA_DIR: path.join(tmpRoot, 'data'),
  GROUPS_DIR: groupsDir,
  IPC_POLL_INTERVAL: 50,
  DANGEROUS_COMMANDS_PATH: path.join(tmpRoot, 'config', 'dangerous-commands.json'),
}));

describe('dev-access-handler: end-to-end request flow', () => {
  beforeEach(() => {
    fs.mkdirSync(path.join(ipcDir, 'access-requests'), { recursive: true });
    fs.mkdirSync(path.join(ipcDir, 'access-responses'), { recursive: true });
    fs.mkdirSync(path.join(groupsDir, 'main'), { recursive: true });
    fs.mkdirSync(path.dirname(allowlistPath), { recursive: true });
    fs.writeFileSync(
      allowlistPath,
      JSON.stringify({
        allowedRoots: [
          { path: tmpRoot, allowReadWrite: false, requireApproval: true },
        ],
        blockedPatterns: [],
        nonMainReadOnly: true,
      }),
    );
    fs.mkdirSync(path.join(tmpRoot, 'TestProj'), { recursive: true });
    sentMessages.length = 0;
  });

  afterEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('processes a request, sends a prompt, and queues it pending', async () => {
    const { startDevAccessHandler } = await import('./dev-access-handler.js');

    const handler = startDevAccessHandler({
      sendMessage: async (jid, text) => {
        sentMessages.push({ jid, text });
      },
      getMainGroup: () => ({
        jid: 'main-jid',
        folder: 'main',
        name: 'Main',
        trigger: '@andy',
        added_at: '',
        isMain: true,
        containerConfig: { devAccessEnabled: true },
      }),
      getRegisteredGroups: () => ({}),
      updateGroupConfig: () => {},
      nanoclawDir: '/tmp/nonexistent-nanoclaw',
    });

    fs.writeFileSync(
      path.join(ipcDir, 'access-requests', 'r1.json'),
      JSON.stringify({
        id: 'r1',
        command: 'request',
        project: 'TestProj',
        reason: 'edit a file',
        requestedAt: new Date().toISOString(),
      }),
    );

    // Wait for the watcher to pick up the request
    await new Promise((r) => setTimeout(r, 200));

    expect(sentMessages).toHaveLength(1);
    expect(sentMessages[0].text).toMatch(/TestProj/);
    expect(sentMessages[0].text).toMatch(/yes\/no/i);
    expect(handler.getPendingForGroup('main')).toHaveLength(1);

    handler.stop();
  });

  it('hard-rail blocks NanoClaw self-dir without sending a prompt', async () => {
    const { startDevAccessHandler } = await import('./dev-access-handler.js');

    fs.mkdirSync(path.join(tmpRoot, 'fake-nanoclaw'), { recursive: true });

    const handler = startDevAccessHandler({
      sendMessage: async (jid, text) => {
        sentMessages.push({ jid, text });
      },
      getMainGroup: () => ({
        jid: 'main-jid',
        folder: 'main',
        name: 'Main',
        trigger: '@andy',
        added_at: '',
        isMain: true,
        containerConfig: { devAccessEnabled: true },
      }),
      getRegisteredGroups: () => ({}),
      updateGroupConfig: () => {},
      nanoclawDir: path.join(tmpRoot, 'fake-nanoclaw'),
    });

    fs.writeFileSync(
      path.join(ipcDir, 'access-requests', 'r-block.json'),
      JSON.stringify({
        id: 'r-block',
        command: 'request',
        project: 'fake-nanoclaw',
        reason: 'try to edit nanoclaw itself',
        requestedAt: new Date().toISOString(),
      }),
    );

    await new Promise((r) => setTimeout(r, 200));

    expect(sentMessages).toHaveLength(0);
    const responseFile = path.join(ipcDir, 'access-responses', 'r-block.json');
    expect(fs.existsSync(responseFile)).toBe(true);
    const response = JSON.parse(fs.readFileSync(responseFile, 'utf-8'));
    expect(response.status).toBe('blocked');

    handler.stop();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/dev-access-handler.test.ts`
Expected: FAIL with module-not-found

- [ ] **Step 3: Implement `src/dev-access-handler.ts`**

```typescript
import fs from 'fs';
import path from 'path';

import { DATA_DIR, GROUPS_DIR, IPC_POLL_INTERVAL } from './config.js';
import { logger } from './logger.js';
import { loadMountAllowlist } from './mount-security.js';
import {
  addSubdirEntry,
  removeSubdirEntry,
  listWritableSubdirs,
} from './allowlist-writer.js';
import { appendAuditEntry } from './dev-access/audit-log.js';
import { validateAccessRequest } from './dev-access/hard-rails.js';
import { PendingQueue, PendingRequest } from './dev-access/pending-queue.js';
import { classifyReply } from './dev-access/reply-classifier.js';
import { RegisteredGroup } from './types.js';

const REQUEST_TIMEOUT_MS = 5 * 60 * 1000;

interface DevAccessDeps {
  sendMessage: (jid: string, text: string) => Promise<void>;
  getMainGroup: () => RegisteredGroup | null;
  getRegisteredGroups: () => Record<string, RegisteredGroup>;
  updateGroupConfig: (jid: string, group: RegisteredGroup) => void;
  nanoclawDir: string;
}

interface DevAccessIncomingRequest {
  id: string;
  command: 'request' | 'revoke' | 'list' | 'clone';
  project?: string;
  owner?: string;
  reason?: string;
  requestedAt: string;
}

export interface DevAccessHandler {
  /** Stop the watcher (used in tests). */
  stop: () => void;
  /** Returns true if any pending request exists for the group. */
  hasPending: (groupFolder: string) => boolean;
  /** List pending requests for a group (used by tests / list command). */
  getPendingForGroup: (groupFolder: string) => PendingRequest[];
  /**
   * Try to resolve a pending request from an inbound user reply. Returns
   * true if the reply was consumed (and should NOT be forwarded to Andy).
   */
  tryConsumeReply: (groupFolder: string, text: string) => Promise<boolean>;
}

export function startDevAccessHandler(deps: DevAccessDeps): DevAccessHandler {
  const queue = new PendingQueue();
  let stopped = false;
  let timer: NodeJS.Timeout | null = null;

  const getRequestsDir = (groupFolder: string) =>
    path.join(DATA_DIR, 'ipc', groupFolder, 'access-requests');
  const getResponsesDir = (groupFolder: string) =>
    path.join(DATA_DIR, 'ipc', groupFolder, 'access-responses');
  const auditPath = (groupFolder: string) =>
    path.join(GROUPS_DIR, groupFolder, 'dev-access.log');

  function writeResponse(
    groupFolder: string,
    id: string,
    body: object,
  ): void {
    const dir = getResponsesDir(groupFolder);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${id}.json`), JSON.stringify(body));
  }

  async function processRequestFile(
    groupFolder: string,
    filePath: string,
  ): Promise<void> {
    const raw = fs.readFileSync(filePath, 'utf-8');
    fs.unlinkSync(filePath);
    const req: DevAccessIncomingRequest = JSON.parse(raw);

    if (req.command === 'list') {
      await handleList(groupFolder, req);
      return;
    }

    if (!req.project) {
      writeResponse(groupFolder, req.id, {
        id: req.id,
        status: 'blocked',
        message: 'Missing project field',
      });
      return;
    }

    const allowlist = loadMountAllowlist();
    const allowedRoots = allowlist?.allowedRoots
      .filter((r) => r.requireApproval)
      .map((r) =>
        r.path.startsWith('~')
          ? path.join(process.env.HOME || '', r.path.slice(2))
          : r.path,
      ) ?? [];

    let absPath: string;
    if (req.command === 'clone') {
      absPath = path.join(allowedRoots[0] ?? '/', req.project);
    } else {
      absPath = path.join(allowedRoots[0] ?? '/', req.project);
    }

    const validation = validateAccessRequest({
      requestedPath: absPath,
      nanoclawDir: deps.nanoclawDir,
      blockedPatterns: allowlist?.blockedPatterns ?? [],
      allowedRootPaths: allowedRoots,
    });

    if (!validation.allowed) {
      appendAuditEntry(auditPath(groupFolder), {
        timestamp: new Date().toISOString(),
        action: 'request-blocked',
        project: req.project,
        source: 'auto-block',
        details: { reason: validation.reason, command: req.command },
      });
      writeResponse(groupFolder, req.id, {
        id: req.id,
        status: 'blocked',
        message: validation.reason,
      });
      return;
    }

    queue.add({
      id: req.id,
      groupFolder,
      command: req.command as 'request' | 'revoke' | 'clone',
      project: req.project,
      owner: req.owner,
      reason: req.reason,
      requestedAt: req.requestedAt,
    });

    const main = deps.getMainGroup();
    if (!main) {
      writeResponse(groupFolder, req.id, {
        id: req.id,
        status: 'timeout',
        message: 'No main group registered to deliver prompt',
      });
      queue.resolveById(groupFolder, req.id);
      return;
    }

    const prompt = formatPrompt(req);
    try {
      await deps.sendMessage(main.jid ?? '', prompt);
    } catch (err) {
      logger.warn(
        { err, requestId: req.id },
        'Failed to deliver dev-access prompt',
      );
      writeResponse(groupFolder, req.id, {
        id: req.id,
        status: 'timeout',
        message: 'Could not deliver prompt to user',
      });
      queue.resolveById(groupFolder, req.id);
    }
  }

  function formatPrompt(req: DevAccessIncomingRequest): string {
    if (req.command === 'request') {
      return `Andy wants write access to ${req.project}${
        req.reason ? ` — '${req.reason}'` : ''
      }. Reply yes/no.`;
    }
    if (req.command === 'revoke') {
      return `Andy wants to revoke write access to ${req.project}. Reply yes/no.`;
    }
    if (req.command === 'clone') {
      return `Andy wants to clone ${req.owner ? req.owner + '/' : ''}${
        req.project
      } into your projects drive. Reply yes/no.`;
    }
    return `Andy sent an access request: ${JSON.stringify(req)}. Reply yes/no.`;
  }

  async function handleList(
    groupFolder: string,
    req: DevAccessIncomingRequest,
  ): Promise<void> {
    const allowlist = loadMountAllowlist();
    const root = allowlist?.allowedRoots.find((r) => r.requireApproval);
    const writable = root
      ? listWritableSubdirs(
          root.path.startsWith('~')
            ? path.join(process.env.HOME || '', root.path.slice(2))
            : root.path,
        )
      : [];
    writeResponse(groupFolder, req.id, {
      id: req.id,
      status: 'granted',
      message: 'list ok',
      details: { writable },
    });
  }

  async function expireStale(): Promise<void> {
    const cutoff = Date.now() - REQUEST_TIMEOUT_MS;
    const expired = queue.expireOlderThan(cutoff);
    for (const r of expired) {
      writeResponse(r.groupFolder, r.id, {
        id: r.id,
        status: 'timeout',
        message: 'No reply received within 5 minutes',
      });
      appendAuditEntry(auditPath(r.groupFolder), {
        timestamp: new Date().toISOString(),
        action: 'timeout',
        project: r.project,
        source: 'timeout',
      });
    }
  }

  async function tick(): Promise<void> {
    if (stopped) return;
    try {
      const ipcBase = path.join(DATA_DIR, 'ipc');
      if (!fs.existsSync(ipcBase)) {
        timer = setTimeout(tick, IPC_POLL_INTERVAL);
        return;
      }
      const groupFolders = fs
        .readdirSync(ipcBase)
        .filter((f) => fs.statSync(path.join(ipcBase, f)).isDirectory());
      for (const groupFolder of groupFolders) {
        const dir = getRequestsDir(groupFolder);
        if (!fs.existsSync(dir)) continue;
        for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.json'))) {
          await processRequestFile(groupFolder, path.join(dir, file));
        }
      }
      await expireStale();
    } catch (err) {
      logger.error({ err }, 'dev-access-handler tick error');
    }
    timer = setTimeout(tick, IPC_POLL_INTERVAL);
  }

  async function tryConsumeReply(
    groupFolder: string,
    text: string,
  ): Promise<boolean> {
    if (!queue.peekOldest(groupFolder)) return false;
    const classified = classifyReply(text);
    if (classified.decision === 'none') return false;

    const resolved = classified.project
      ? queue.resolveByProject(groupFolder, classified.project)
      : queue.resolveOldest(groupFolder);
    if (!resolved) return false;

    if (classified.decision === 'affirmative') {
      await applyGrant(resolved);
    } else {
      await applyDenial(resolved);
    }
    return true;
  }

  async function applyGrant(req: PendingRequest): Promise<void> {
    const allowlist = loadMountAllowlist();
    const root = allowlist?.allowedRoots.find((r) => r.requireApproval);
    const rootPath = root
      ? root.path.startsWith('~')
        ? path.join(process.env.HOME || '', root.path.slice(2))
        : root.path
      : '/';

    const projectPath = path.join(rootPath, req.project!);

    if (req.command === 'clone') {
      // Caller (orchestrator) performs the clone. Here we record the grant
      // as if the dir existed; if clone fails, downstream will error.
      addSubdirEntry({
        path: projectPath,
        description: `Granted via dev-access clone on ${new Date().toISOString().slice(0, 10)}`,
      });
      registerMountInGroup(req.groupFolder, projectPath, req.project!);
      writeResponse(req.groupFolder, req.id, {
        id: req.id,
        status: 'granted',
        message: 'clone-and-mount queued; orchestrator will run gh repo clone',
        details: { project: req.project, mountPath: `/workspace/dev/${req.project}` },
      });
      appendAuditEntry(auditPath(req.groupFolder), {
        timestamp: new Date().toISOString(),
        action: 'clone',
        project: req.project,
        source: 'signal-reply',
        details: { owner: req.owner },
      });
      return;
    }

    if (req.command === 'revoke') {
      removeSubdirEntry(projectPath);
      unregisterMountInGroup(req.groupFolder, projectPath);
      writeResponse(req.groupFolder, req.id, {
        id: req.id,
        status: 'granted',
        message: `Revoked write access to ${req.project}`,
      });
      appendAuditEntry(auditPath(req.groupFolder), {
        timestamp: new Date().toISOString(),
        action: 'revoke',
        project: req.project,
        source: 'signal-reply',
      });
      return;
    }

    // request
    addSubdirEntry({
      path: projectPath,
      description: `Granted via dev-access on ${new Date().toISOString().slice(0, 10)}`,
    });
    registerMountInGroup(req.groupFolder, projectPath, req.project!);
    writeResponse(req.groupFolder, req.id, {
      id: req.id,
      status: 'granted',
      message: `Granted write access to ${req.project}. Tell Greg to ping you to retry.`,
      details: { project: req.project, mountPath: `/workspace/dev/${req.project}` },
    });
    appendAuditEntry(auditPath(req.groupFolder), {
      timestamp: new Date().toISOString(),
      action: 'grant',
      project: req.project,
      source: 'signal-reply',
      details: { reason: req.reason },
    });
  }

  async function applyDenial(req: PendingRequest): Promise<void> {
    writeResponse(req.groupFolder, req.id, {
      id: req.id,
      status: 'denied',
      message: 'Greg said no.',
    });
    appendAuditEntry(auditPath(req.groupFolder), {
      timestamp: new Date().toISOString(),
      action:
        req.command === 'revoke' ? 'revoke' : 'request-blocked',
      project: req.project,
      source: 'signal-reply',
      details: { command: req.command, denied: true },
    });
  }

  function registerMountInGroup(
    groupFolder: string,
    hostPath: string,
    containerName: string,
  ): void {
    const groups = deps.getRegisteredGroups();
    const entry = Object.entries(groups).find(
      ([, g]) => g.folder === groupFolder,
    );
    if (!entry) return;
    const [jid, group] = entry;
    const config = group.containerConfig ?? {};
    const mounts = config.additionalMounts ?? [];
    const containerPath = `dev/${containerName}`;
    if (mounts.some((m) => m.containerPath === containerPath)) return;
    mounts.push({ hostPath, containerPath, readonly: false });
    const updated: RegisteredGroup = {
      ...group,
      containerConfig: { ...config, additionalMounts: mounts },
    };
    deps.updateGroupConfig(jid, updated);
  }

  function unregisterMountInGroup(
    groupFolder: string,
    hostPath: string,
  ): void {
    const groups = deps.getRegisteredGroups();
    const entry = Object.entries(groups).find(
      ([, g]) => g.folder === groupFolder,
    );
    if (!entry) return;
    const [jid, group] = entry;
    const config = group.containerConfig;
    if (!config?.additionalMounts) return;
    const remaining = config.additionalMounts.filter(
      (m) => m.hostPath !== hostPath,
    );
    if (remaining.length === config.additionalMounts.length) return;
    const updated: RegisteredGroup = {
      ...group,
      containerConfig: { ...config, additionalMounts: remaining },
    };
    deps.updateGroupConfig(jid, updated);
  }

  // Boot
  timer = setTimeout(tick, IPC_POLL_INTERVAL);

  return {
    stop: () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
    hasPending: (groupFolder) => queue.peekOldest(groupFolder) !== null,
    getPendingForGroup: (groupFolder) => queue.list(groupFolder),
    tryConsumeReply,
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/dev-access-handler.test.ts`
Expected: PASS (both end-to-end tests). If a test depends on `getMainGroup()` returning a `jid`, ensure the type extension was made — adjust as required to match the existing `RegisteredGroup` shape (which currently has `jid` as the map key, not a field). Update the deps signature so `getMainGroup` returns `{ jid, group }` if cleaner.

- [ ] **Step 5: Commit**

```bash
git add src/dev-access-handler.ts src/dev-access-handler.test.ts
git commit -m "feat(dev-access-handler): IPC watcher + grant/revoke/clone/list

The host-side handler watches /data/ipc/<group>/access-requests/,
validates against hard rails, queues each request, and prompts
the user via the registered channel. Replies are intercepted by
the message loop and consumed via tryConsumeReply(). On grant,
the handler mutates the mount allowlist and the group's
container_config.additionalMounts atomically; on revoke, it
removes them. Audit-logs every decision."
```

---

## Phase 10: Wire Handler Into the Message Loop

### Task 10.1: Inbound interception and `setRegisteredGroup` writeback

**Files:**
- Modify: `src/index.ts`
- Modify: `src/db.ts` (only if `setRegisteredGroup` doesn't already accept full updates — check first)

- [ ] **Step 1: Verify db.ts behaviour**

Run: `grep -n "setRegisteredGroup\|registered_groups" src/db.ts | head -20`

If `setRegisteredGroup` already serialises `containerConfig` to the `container_config` column on UPSERT, no change needed. Otherwise, extend it.

- [ ] **Step 2: Modify `src/index.ts` main() to start the dev-access handler**

Add after `startSchedulerLoop({...});` and before/around `startIpcWatcher({...});`:

```typescript
import { startDevAccessHandler, DevAccessHandler } from './dev-access-handler.js';

let devAccessHandler: DevAccessHandler | null = null;

// (inside main, after channels are connected and registeredGroups loaded)
devAccessHandler = startDevAccessHandler({
  sendMessage: async (jid, text) => {
    const channel = findChannel(channels, jid);
    if (!channel) {
      logger.warn({ jid }, 'No channel for dev-access prompt');
      return;
    }
    await channel.sendMessage(jid, text);
  },
  getMainGroup: () => {
    const entry = Object.entries(registeredGroups).find(
      ([, g]) => g.isMain,
    );
    if (!entry) return null;
    const [jid, g] = entry;
    return { ...g, jid } as RegisteredGroup & { jid: string };
  },
  getRegisteredGroups: () => registeredGroups,
  updateGroupConfig: (jid, updated) => {
    registeredGroups[jid] = updated;
    setRegisteredGroup(jid, updated);
  },
  nanoclawDir: process.cwd(),
});
```

(Add appropriate handling so the deps interface in `dev-access-handler.ts` matches what's wired here — adjust `RegisteredGroup`'s fields versus the map-key `jid` accordingly.)

- [ ] **Step 3: Intercept replies in the message loop**

In `processGroupMessages` (or wherever the user's text is consumed before being forwarded to Andy), add an interception step. Locate the section where `groupMessages` is converted into the agent prompt — before `formatMessages`, filter out messages that the dev-access handler consumes:

```typescript
// Intercept dev-access yes/no replies for the main group with pending requests
if (devAccessHandler && isMainGroup && devAccessHandler.hasPending(group.folder)) {
  const remaining: NewMessage[] = [];
  for (const m of missedMessages) {
    if (m.is_from_me || !devAccessHandler) {
      remaining.push(m);
      continue;
    }
    // Only Greg's replies (not Andy's) get classified
    if (await devAccessHandler.tryConsumeReply(group.folder, m.content)) {
      // Reply consumed; advance cursor past it but don't forward to Andy
      lastAgentTimestamp[chatJid] = m.timestamp;
      saveState();
      continue;
    }
    remaining.push(m);
  }
  if (remaining.length === 0) return true; // nothing left to send
  // Replace missedMessages with the filtered list for downstream code
  missedMessages.splice(0, missedMessages.length, ...remaining);
}
```

(If the existing function shape doesn't allow this exact splice, extract a helper at the top of the function. Place the interception after the trigger check and before `formatMessages(missedMessages, ...)`.)

- [ ] **Step 4: Build & typecheck**

Run: `npm run build`
Expected: PASS. If type errors mention the `getMainGroup` shape, normalise the deps interface to a single shape (e.g. `(group: RegisteredGroup & { jid: string }) | null`) and propagate.

- [ ] **Step 5: Commit**

```bash
git add src/index.ts src/dev-access-handler.ts
git commit -m "feat(index): wire dev-access handler into the message loop

Starts the handler in main() with deps bound to channel send,
registered-group state, and SQLite writeback. Intercepts replies
to pending dev-access prompts before they reach Andy so a yes/no
in chat resolves the request without polluting the agent's
context."
```

---

## Phase 11: Container Skill (CLI + Prose)

### Task 11.1: Bash CLI inside the container

**Files:**
- Create: `container/skills/dev-access/dev-access`
- Create: `container/skills/dev-access/SKILL.md`

- [ ] **Step 1: Write the bash CLI**

Create `container/skills/dev-access/dev-access` (executable bash):

```bash
#!/usr/bin/env bash
# dev-access — request/revoke/list/clone for the developer-access feature.
# Marshals JSON IPC requests to the host orchestrator and waits for the response.
set -euo pipefail

IPC_REQ_DIR=/workspace/ipc/access-requests
IPC_RES_DIR=/workspace/ipc/access-responses
TIMEOUT=300  # seconds — must match host REQUEST_TIMEOUT_MS

usage() {
  cat <<EOF
Usage: dev-access <command> [args]

Commands:
  request <project> "<reason>"   Ask for write access to a project under /workspace/dev
  revoke  <project>              Drop write access to a project
  list                            Show currently-writable projects
  clone   <owner/repo>            Clone a repo from GitHub into the projects drive

Hard rails (always denied, no prompt):
  - The NanoClaw source directory itself
  - Anything matching default secret patterns (.ssh, .env, etc.)

The user will receive a Signal/etc prompt and must reply yes or no.
You can also say "list" anytime to remind yourself what is writable.
EOF
}

uuid() {
  od -An -N16 -tx1 /dev/urandom | tr -d ' \n'
}

submit() {
  local payload=$1
  local id=$2
  mkdir -p "$IPC_REQ_DIR" "$IPC_RES_DIR"
  echo "$payload" > "$IPC_REQ_DIR/$id.json"

  local elapsed=0
  while [ "$elapsed" -lt "$TIMEOUT" ]; do
    if [ -f "$IPC_RES_DIR/$id.json" ]; then
      cat "$IPC_RES_DIR/$id.json"
      rm -f "$IPC_RES_DIR/$id.json"
      return 0
    fi
    sleep 1
    elapsed=$((elapsed+1))
  done

  echo '{"status":"timeout","message":"No response after 5 minutes"}'
  return 1
}

cmd=${1:-}
case "$cmd" in
  request)
    project=${2:-}
    reason=${3:-}
    [ -z "$project" ] && { usage; exit 2; }
    id=$(uuid)
    submit "$(jq -n --arg id "$id" --arg project "$project" --arg reason "$reason" \
             --arg ts "$(date -u +%FT%TZ)" \
             '{id:$id, command:"request", project:$project, reason:$reason, requestedAt:$ts}')" "$id"
    ;;
  revoke)
    project=${2:-}
    [ -z "$project" ] && { usage; exit 2; }
    id=$(uuid)
    submit "$(jq -n --arg id "$id" --arg project "$project" \
             --arg ts "$(date -u +%FT%TZ)" \
             '{id:$id, command:"revoke", project:$project, requestedAt:$ts}')" "$id"
    ;;
  list)
    id=$(uuid)
    submit "$(jq -n --arg id "$id" --arg ts "$(date -u +%FT%TZ)" \
             '{id:$id, command:"list", requestedAt:$ts}')" "$id"
    ;;
  clone)
    spec=${2:-}
    [ -z "$spec" ] && { usage; exit 2; }
    owner=${spec%%/*}
    project=${spec##*/}
    id=$(uuid)
    submit "$(jq -n --arg id "$id" --arg project "$project" --arg owner "$owner" \
             --arg ts "$(date -u +%FT%TZ)" \
             '{id:$id, command:"clone", project:$project, owner:$owner, requestedAt:$ts}')" "$id"
    ;;
  -h|--help|help|"")
    usage
    ;;
  *)
    usage
    exit 2
    ;;
esac
```

- [ ] **Step 2: Mark executable**

Run: `chmod +x container/skills/dev-access/dev-access`

- [ ] **Step 3: Write SKILL.md**

Create `container/skills/dev-access/SKILL.md`:

```markdown
---
name: dev-access
description: View and edit projects on Greg's developer drive at /workspace/dev. Handles read-only-by-default access, runtime write-grant elevation via Signal, and conversational request/revoke/list/clone operations.
---

# Developer Access

Greg's projects live at `/workspace/dev/` (read-only at the root). You can
read, browse, and grep anything in there freely. To edit, you need a
per-project grant from Greg, which you can request from inside the chat.

## How to use

```bash
dev-access list                                 # what can I write to right now?
dev-access request VoltWise "fix forecaster"    # ask for write on VoltWise
dev-access revoke VoltWise                      # drop write on VoltWise
dev-access clone mudislandkid/some-old-repo     # clone a repo into /workspace/dev
```

## Workflow

1. Read the project at `/workspace/dev/<project>/` to understand what's needed.
2. Try the edit. If the filesystem returns "Read-only file system", that's
   expected — run `dev-access request <project> "<short reason>"`.
3. The script blocks until Greg replies on his channel. On approval you'll
   see `status:granted`. **The new mount only takes effect on your next
   container spawn**, so reply to Greg with: "Got write access to <project>.
   Ping me to retry."
4. Greg pings ("ok go ahead"); you re-enter, the mount is now RW; complete
   the edit; commit and push via `git`/`gh`; open the PR.

## When to ask for things

- **Write access** — only when you actually need to write. Browsing/reading
  is always free.
- **Cloning** — only when the project isn't already at `/workspace/dev/`.
  Don't preemptively clone things "just in case".
- **Revoking** — when Greg asks ("drop write on X") OR proactively after
  long inactivity on a project (optional but neat).

## Hard rails (auto-denied without prompting Greg)

- NanoClaw's own source directory — modifying it would break the sandbox.
  Greg edits NanoClaw on his laptop directly.
- Anything matching default secret patterns (.ssh, .env, .aws, etc.).
- Paths outside any allowed root.

If you get `status:blocked`, do **not** retry — the answer is final.

## Destructive commands

Some Bash commands (`rm -rf`, `git push --force`, `git reset --hard`,
package removals, DB drops, clobber-redirects to .env/lockfiles) require
a per-command nod from Greg. The hook runs automatically — when you
issue one, expect a 5–60s pause while Greg confirms. If denied, abort
gracefully and tell Greg what you were trying to do.

## GitHub coexistence

You also have the `github` skill — `gh` CLI for repos, PRs, issues,
Dependabot. Combine: read locally → edit locally (with grant) →
`git checkout -b fix/...` → commit → `git push` → `gh pr create`.
```

- [ ] **Step 4: Commit**

```bash
git add container/skills/dev-access/dev-access container/skills/dev-access/SKILL.md
git commit -m "feat(container/skills): dev-access CLI + prose

Bash front-end Andy uses to request/revoke/list/clone via IPC,
plus the SKILL.md instructions explaining the workflow, hard
rails, and one-extra-message UX after a grant lands."
```

---

## Phase 12: Destructive Command PreToolUse Hook

### Task 12.1: Hook script in agent-runner

**Files:**
- Create: `container/agent-runner/src/destructive-hook.ts`

- [ ] **Step 1: Implement the hook**

```typescript
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { HookCallback } from '@anthropic-ai/claude-agent-sdk';

const IPC_REQ_DIR = '/workspace/ipc/dangerous-commands';
const IPC_RES_DIR = '/workspace/ipc/dangerous-responses';
const POLL_MS = 500;
const TIMEOUT_MS = 5 * 60 * 1000;

export interface DangerousHookConfig {
  patterns: RegExp[];
  hardDeny: RegExp[];
}

/**
 * Read pattern config from /workspace/ipc/dangerous-commands.json which the
 * orchestrator copies in at container startup. Empty arrays disable the gate.
 */
export function loadDangerousConfig(): DangerousHookConfig {
  const cfgPath = '/workspace/ipc/dangerous-commands.json';
  if (!fs.existsSync(cfgPath)) return { patterns: [], hardDeny: [] };
  try {
    const raw = JSON.parse(fs.readFileSync(cfgPath, 'utf-8'));
    return {
      patterns: (raw.patterns ?? []).map((p: string) => new RegExp(p, 'i')),
      hardDeny: (raw.hardDenyPatterns ?? []).map(
        (p: string) => new RegExp(p, 'i'),
      ),
    };
  } catch {
    return { patterns: [], hardDeny: [] };
  }
}

interface PreToolUseInput {
  tool_name?: string;
  tool_input?: { command?: string; description?: string };
}

export function createDestructiveHook(): HookCallback {
  return async (input, _toolUseId, _context) => {
    const evt = input as PreToolUseInput;
    if (evt.tool_name !== 'Bash') return {};
    const command = evt.tool_input?.command ?? '';
    if (!command) return {};

    const cfg = loadDangerousConfig();

    for (const re of cfg.hardDeny) {
      if (re.test(command)) {
        return {
          decision: 'block',
          reason: `Command auto-blocked by NanoClaw destructive-command gate (pattern: ${re.source})`,
        } as never; // SDK type is permissive; fields conform to permission decisions.
      }
    }

    let asked = false;
    for (const re of cfg.patterns) {
      if (re.test(command)) {
        asked = true;
        break;
      }
    }
    if (!asked) return {};

    // Submit IPC request and poll
    fs.mkdirSync(IPC_REQ_DIR, { recursive: true });
    fs.mkdirSync(IPC_RES_DIR, { recursive: true });
    const id = crypto.randomUUID();
    const reqFile = path.join(IPC_REQ_DIR, `${id}.json`);
    const resFile = path.join(IPC_RES_DIR, `${id}.json`);
    fs.writeFileSync(
      reqFile,
      JSON.stringify({
        id,
        command,
        cwd: process.cwd(),
        requestedAt: new Date().toISOString(),
      }),
    );

    const start = Date.now();
    while (Date.now() - start < TIMEOUT_MS) {
      if (fs.existsSync(resFile)) {
        const res = JSON.parse(fs.readFileSync(resFile, 'utf-8'));
        try { fs.unlinkSync(resFile); } catch { /* ignore */ }
        if (res.status === 'approved') return {};
        return {
          decision: 'block',
          reason: `Destructive command not approved by user: ${res.message ?? 'denied'}`,
        } as never;
      }
      await new Promise((r) => setTimeout(r, POLL_MS));
    }
    return {
      decision: 'block',
      reason: 'Destructive command timed out waiting for user approval',
    } as never;
  };
}
```

- [ ] **Step 2: Wire it into `container/agent-runner/src/index.ts`**

In `runQuery()`, find the `hooks: { PreCompact: ... }` block and extend it:

```typescript
import { createDestructiveHook } from './destructive-hook.js';

// inside runQuery, in the options object:
hooks: {
  PreCompact: [{ hooks: [createPreCompactHook(containerInput.assistantName)] }],
  PreToolUse: [{ hooks: [createDestructiveHook()] }],
},
```

- [ ] **Step 3: Build the agent-runner**

The agent-runner is recompiled on container startup; ensure `package.json` and `tsconfig.json` in `container/agent-runner/` include the new file in compilation. Inspect:

Run: `ls container/agent-runner/`
Run: `cat container/agent-runner/tsconfig.json 2>/dev/null || true`

If the file already uses globbed `src/**/*.ts`, it's automatically included. If listed explicitly, append `src/destructive-hook.ts`.

- [ ] **Step 4: Build the host project to ensure no regressions**

Run: `npm run build`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add container/agent-runner/src/destructive-hook.ts container/agent-runner/src/index.ts
git commit -m "feat(agent-runner): PreToolUse hook for destructive commands

Intercepts Bash tool calls, regex-matches against patterns shipped
to the container at /workspace/ipc/dangerous-commands.json, and:
  - hardDeny pattern → block with no prompt
  - ask pattern      → IPC round-trip via dangerous-commands/, blocking
                        until approved or timeout (5 min)
  - no match         → allow

Coexists with the existing PreCompact hook; the SDK handles
multiple hook entries fine."
```

---

## Phase 13: Handler Plumbing for Dangerous-Command Requests

### Task 13.1: Watch dangerous-commands IPC dir, prompt and respond

**Files:**
- Modify: `src/dev-access-handler.ts`
- Modify: `src/dev-access-handler.test.ts`

- [ ] **Step 1: Add a failing test**

Append to `src/dev-access-handler.test.ts`:

```typescript
describe('dev-access-handler: dangerous-command flow', () => {
  beforeEach(() => {
    fs.mkdirSync(path.join(ipcDir, 'dangerous-commands'), { recursive: true });
    fs.mkdirSync(path.join(ipcDir, 'dangerous-responses'), { recursive: true });
  });

  it('prompts and on yes writes approved response', async () => {
    const { startDevAccessHandler } = await import('./dev-access-handler.js');

    let capturedJid = '';
    const handler = startDevAccessHandler({
      sendMessage: async (jid, text) => {
        capturedJid = jid;
        sentMessages.push({ jid, text });
      },
      getMainGroup: () => ({
        jid: 'main-jid',
        folder: 'main',
        name: 'Main',
        trigger: '@andy',
        added_at: '',
        isMain: true,
        containerConfig: { devAccessEnabled: true },
      }),
      getRegisteredGroups: () => ({}),
      updateGroupConfig: () => {},
      nanoclawDir: '/tmp/nope',
    });

    fs.writeFileSync(
      path.join(ipcDir, 'dangerous-commands', 'd1.json'),
      JSON.stringify({
        id: 'd1',
        command: 'rm -rf .next/',
        cwd: '/workspace/dev/TestProj',
        requestedAt: new Date().toISOString(),
      }),
    );

    await new Promise((r) => setTimeout(r, 200));
    expect(sentMessages.some((m) => m.text.includes('rm -rf'))).toBe(true);

    await handler.tryConsumeReply('main', 'yes');
    await new Promise((r) => setTimeout(r, 100));

    const resFile = path.join(ipcDir, 'dangerous-responses', 'd1.json');
    expect(fs.existsSync(resFile)).toBe(true);
    const res = JSON.parse(fs.readFileSync(resFile, 'utf-8'));
    expect(res.status).toBe('approved');

    handler.stop();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/dev-access-handler.test.ts -t "dangerous-command flow"`
Expected: FAIL

- [ ] **Step 3: Extend `dev-access-handler.ts`**

In the `tick()` function, after scanning `access-requests/`, also scan `dangerous-commands/`:

```typescript
const dangerousDir = path.join(DATA_DIR, 'ipc', groupFolder, 'dangerous-commands');
if (fs.existsSync(dangerousDir)) {
  for (const file of fs.readdirSync(dangerousDir).filter((f) => f.endsWith('.json'))) {
    await processDangerousRequestFile(groupFolder, path.join(dangerousDir, file));
  }
}
```

Add the helper:

```typescript
async function processDangerousRequestFile(
  groupFolder: string,
  filePath: string,
): Promise<void> {
  const raw = fs.readFileSync(filePath, 'utf-8');
  fs.unlinkSync(filePath);
  const req = JSON.parse(raw) as {
    id: string;
    command: string;
    cwd?: string;
    requestedAt: string;
  };

  // Project hint: derive from cwd (e.g., /workspace/dev/VoltWise/...)
  const projectMatch = (req.cwd ?? '').match(/^\/workspace\/dev\/([^/]+)/);
  const project = projectMatch?.[1];

  queue.add({
    id: req.id,
    groupFolder,
    command: 'request', // reused enum slot — distinguishable by fullCommand presence
    project,
    fullCommand: req.command,
    cwd: req.cwd,
    requestedAt: req.requestedAt,
  });

  const main = deps.getMainGroup();
  if (!main) {
    writeDangerousResponse(groupFolder, req.id, {
      id: req.id,
      status: 'timeout',
      message: 'No main group registered',
    });
    queue.resolveById(groupFolder, req.id);
    return;
  }

  const prompt = `Andy wants to run \`${req.command}\`${
    project ? ` in ${project}` : ''
  }. Reply yes/no.`;
  try {
    await deps.sendMessage(main.jid ?? '', prompt);
  } catch (err) {
    logger.warn({ err, id: req.id }, 'Failed to send dangerous-command prompt');
    writeDangerousResponse(groupFolder, req.id, {
      id: req.id,
      status: 'timeout',
      message: 'Could not deliver prompt',
    });
    queue.resolveById(groupFolder, req.id);
  }
}

function writeDangerousResponse(
  groupFolder: string,
  id: string,
  body: object,
): void {
  const dir = path.join(DATA_DIR, 'ipc', groupFolder, 'dangerous-responses');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${id}.json`), JSON.stringify(body));
}
```

In `applyGrant`, add a branch at the top:

```typescript
async function applyGrant(req: PendingRequest): Promise<void> {
  if (req.fullCommand) {
    writeDangerousResponse(req.groupFolder, req.id, {
      id: req.id,
      status: 'approved',
      message: 'User approved',
    });
    appendAuditEntry(
      path.join(GROUPS_DIR, req.groupFolder, 'dangerous-commands.log'),
      {
        timestamp: new Date().toISOString(),
        action: 'dangerous-approved',
        project: req.project,
        source: 'signal-reply',
        details: { command: req.fullCommand, cwd: req.cwd },
      },
    );
    return;
  }
  // ... existing branches
}
```

In `applyDenial`, add a similar branch.

In `expireStale`, write `denied` (not `timeout`) to the dangerous-responses file when `r.fullCommand` is set so the hook fails the command rather than retrying.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/dev-access-handler.test.ts`
Expected: PASS (all tests, both access and dangerous-command flows)

- [ ] **Step 5: Commit**

```bash
git add src/dev-access-handler.ts src/dev-access-handler.test.ts
git commit -m "feat(dev-access-handler): handle dangerous-command IPC

Adds a parallel watch on /data/ipc/<group>/dangerous-commands/.
Each request becomes a pending entry that is resolved by the
same yes/no reply classifier — affirmatives write 'approved' to
dangerous-responses/, negatives and timeouts write 'denied'.
Audit log is written to dangerous-commands.log per group."
```

---

## Phase 14: Container-Runner Wiring for Dangerous-Commands Config

### Task 14.1: Copy dangerous-commands.json into the container IPC dir at spawn

**Files:**
- Modify: `src/container-runner.ts`

- [ ] **Step 1: Read the relevant section to find the right spot**

In `buildVolumeMounts`, after `fs.mkdirSync(path.join(groupIpcDir, ...))` calls, copy the host's `DANGEROUS_COMMANDS_PATH` into `groupIpcDir/dangerous-commands.json`:

```typescript
import { DANGEROUS_COMMANDS_PATH } from './config.js';

// ... inside buildVolumeMounts, after creating groupIpcDir subdirs:
if (group.containerConfig?.devAccessEnabled) {
  if (fs.existsSync(DANGEROUS_COMMANDS_PATH)) {
    fs.copyFileSync(
      DANGEROUS_COMMANDS_PATH,
      path.join(groupIpcDir, 'dangerous-commands.json'),
    );
  }
  fs.mkdirSync(path.join(groupIpcDir, 'access-requests'), { recursive: true });
  fs.mkdirSync(path.join(groupIpcDir, 'access-responses'), { recursive: true });
  fs.mkdirSync(path.join(groupIpcDir, 'dangerous-commands'), { recursive: true });
  fs.mkdirSync(path.join(groupIpcDir, 'dangerous-responses'), { recursive: true });
}
```

- [ ] **Step 2: Build to confirm no regressions**

Run: `npm run build`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/container-runner.ts
git commit -m "feat(container-runner): copy dangerous-commands config + IPC dirs

When devAccessEnabled is on, the orchestrator copies the host
~/.config/nanoclaw/dangerous-commands.json into the group's IPC
namespace as dangerous-commands.json — the hook reads it at
runtime. Also pre-creates access-requests/, access-responses/,
dangerous-commands/, dangerous-responses/ so the agent's CLI
and hook scripts don't need mkdir privilege races."
```

---

## Phase 15: Host CLI for Manual Hot-Reload

### Task 15.1: `nanoclaw-mount-reload` script

**Files:**
- Create: `bin/nanoclaw-mount-reload.ts`

- [ ] **Step 1: Implement the CLI**

```typescript
#!/usr/bin/env node
/**
 * nanoclaw-mount-reload — invalidate cached mount-allowlist and
 * dangerous-commands config so the next container spawn picks up
 * any hand-edits you made.
 *
 * Usage: nanoclaw-mount-reload
 *
 * This works by sending SIGUSR1 to the running NanoClaw process.
 * NanoClaw's signal handler (added in src/index.ts) calls the
 * invalidate functions in-process. If NanoClaw isn't running,
 * editing the files takes effect on next start anyway, so this
 * exits successfully with a note.
 */

import fs from 'fs';
import path from 'path';
import os from 'os';

const PID_FILE = path.join(os.homedir(), '.config', 'nanoclaw', 'nanoclaw.pid');

function main(): void {
  if (!fs.existsSync(PID_FILE)) {
    console.log(
      'nanoclaw-mount-reload: no PID file at',
      PID_FILE,
      '\nNanoClaw is probably not running. Edits take effect on next start.',
    );
    return;
  }
  const pid = parseInt(fs.readFileSync(PID_FILE, 'utf-8').trim(), 10);
  if (Number.isNaN(pid)) {
    console.error('Invalid PID in', PID_FILE);
    process.exit(1);
  }
  try {
    process.kill(pid, 'SIGUSR1');
    console.log('nanoclaw-mount-reload: signalled PID', pid);
  } catch (err) {
    console.error('Failed to signal NanoClaw:', err);
    process.exit(1);
  }
}

main();
```

- [ ] **Step 2: Add SIGUSR1 handler in `src/index.ts`**

In `main()`, after the SIGTERM/SIGINT handlers:

```typescript
import { invalidateAllowlistCache } from './mount-security.js';
import { invalidateDangerousCommandsCache } from './dangerous-commands.js';
import { MOUNT_ALLOWLIST_PATH } from './config.js';
// (above imports)

process.on('SIGUSR1', () => {
  logger.info('SIGUSR1 received — reloading mount allowlist and dangerous-commands cache');
  invalidateAllowlistCache();
  invalidateDangerousCommandsCache();
});
```

Also write the PID file at startup:

```typescript
import os from 'os';
const pidFile = path.join(os.homedir(), '.config', 'nanoclaw', 'nanoclaw.pid');
fs.mkdirSync(path.dirname(pidFile), { recursive: true });
fs.writeFileSync(pidFile, String(process.pid));
process.on('exit', () => { try { fs.unlinkSync(pidFile); } catch { /* ignore */ } });
```

- [ ] **Step 3: Build**

Run: `npm run build`
Expected: PASS

- [ ] **Step 4: Manual smoke test**

Start NanoClaw (`npm run dev` or via launchctl), then in another terminal:

Run: `tsx bin/nanoclaw-mount-reload.ts`
Expected: prints `signalled PID <number>`. Check NanoClaw log for the reload message.

- [ ] **Step 5: Commit**

```bash
git add bin/nanoclaw-mount-reload.ts src/index.ts
git commit -m "feat(bin): nanoclaw-mount-reload CLI for hot-reload

Sends SIGUSR1 to the running NanoClaw process which clears the
mount-allowlist and dangerous-commands caches. Lets Greg edit
either config file by hand and have it take effect without
restarting the orchestrator. PID file lives at
~/.config/nanoclaw/nanoclaw.pid."
```

---

## Phase 16: Install Skill

### Task 16.1: `.claude/skills/add-developer-access/SKILL.md`

**Files:**
- Create: `.claude/skills/add-developer-access/SKILL.md`

- [ ] **Step 1: Author the install skill**

```markdown
---
name: add-developer-access
description: Give Andy view/edit access to projects on /Volumes/1tbSSD/, with conversational runtime control over write permissions and per-command approval for destructive Bash commands. Designed for the main group only.
---

# Add Developer Access

Wire the developer-access feature into NanoClaw. After this:

- Andy can read every project at `/workspace/dev/` (RO)
- Andy can request write access to specific projects via `dev-access request <project> "<reason>"` — Greg confirms in chat
- Destructive Bash commands (`rm -rf`, `git push --force`, etc.) prompt Greg per-command before running
- Hard rails block NanoClaw self-dir, default secret patterns, traversal, and `rm -rf /` literals

## Phase 1: Pre-flight

```bash
test -d /Volumes/1tbSSD || { echo "MISSING_SSD"; exit 1; }
test -f .env && grep -q '^ASSISTANT_NAME=' .env || echo "WARN: assistant name not set"
node --input-type=module -e "
  import Database from 'better-sqlite3';
  const db = new Database('store/messages.db');
  const main = db.prepare(\"SELECT jid, name FROM registered_groups WHERE jid IN (SELECT jid FROM registered_groups LIMIT 1)\").get();
  console.log(main ? 'MAIN_OK' : 'NO_MAIN');
"
```

If any check fails, tell the user what to fix and stop.

## Phase 2: Write `dangerous-commands.json`

```bash
mkdir -p ~/.config/nanoclaw
test -f ~/.config/nanoclaw/dangerous-commands.json && echo "EXISTS" || cat > ~/.config/nanoclaw/dangerous-commands.json <<'EOF'
{
  "patterns": [
    "rm\\s+(-[a-zA-Z]*[rRf][a-zA-Z]*\\s+|--force\\s+|--recursive\\s+)",
    "git\\s+push\\s+.*(--force(-with-lease)?|-f\\b)",
    "git\\s+reset\\s+--hard",
    "git\\s+clean\\s+-[a-zA-Z]*[fd]",
    "git\\s+branch\\s+-D",
    "\\bdropdb\\b",
    "DROP\\s+(TABLE|DATABASE|SCHEMA)",
    ">\\s*(\\.env|package\\.json|.*\\.lock)\\b",
    "find\\s+.*-delete",
    "find\\s+.*-exec\\s+rm",
    "(npm|yarn|pnpm)\\s+(uninstall|remove)\\b"
  ],
  "hardDenyPatterns": [
    "rm\\s+(-[rRf]+\\s+)?/\\s*$",
    "rm\\s+(-[rRf]+\\s+)?/\\*"
  ]
}
EOF
```

If EXISTS, ask the user whether to overwrite or skip.

## Phase 3: Update mount allowlist

Add the SSD root entry to `~/.config/nanoclaw/mount-allowlist.json` with `requireApproval: true`. Preserve other entries:

```bash
node --input-type=module -e "
  import fs from 'fs';
  import os from 'os';
  import path from 'path';
  const p = path.join(os.homedir(), '.config', 'nanoclaw', 'mount-allowlist.json');
  let cfg;
  try { cfg = JSON.parse(fs.readFileSync(p, 'utf-8')); }
  catch { cfg = { allowedRoots: [], blockedPatterns: [], nonMainReadOnly: true }; }
  if (!cfg.allowedRoots.some(r => r.path === '/Volumes/1tbSSD')) {
    cfg.allowedRoots.push({
      path: '/Volumes/1tbSSD',
      allowReadWrite: false,
      requireApproval: true,
      description: 'Developer projects drive — RO root, RW per-subdir on grant'
    });
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify(cfg, null, 2) + '\n');
    console.log('Added SSD root to allowlist');
  } else {
    console.log('SSD root already in allowlist');
  }
"
```

## Phase 4: Set `devAccessEnabled` on the main group

```bash
node --input-type=module -e "
  import Database from 'better-sqlite3';
  const db = new Database('store/messages.db');
  const main = db.prepare(\"SELECT jid, container_config FROM registered_groups\").all().find(r => {
    try { return JSON.parse(r.container_config || '{}').isMain ?? false; } catch { return false; }
  }) || db.prepare(\"SELECT jid, container_config FROM registered_groups LIMIT 1\").get();
  // Heuristic: assume the only registered group is main, or the user names it
  // (You may need to ask Greg which JID corresponds to main.)
  const cfg = main.container_config ? JSON.parse(main.container_config) : {};
  cfg.devAccessEnabled = true;
  db.prepare('UPDATE registered_groups SET container_config = ? WHERE jid = ?').run(JSON.stringify(cfg), main.jid);
  console.log('devAccessEnabled set on', main.jid);
"
```

If the heuristic isn't reliable, ask the user which group is main and update that JID directly.

## Phase 5: Add CLAUDE.md section to main group

Append to `groups/main/CLAUDE.md` (create if missing):

```markdown
## Developer Access

You have access to Greg's project directory at `/workspace/dev/`. The
root is read-only; you can browse and read everything freely. To edit,
run `dev-access request <project> "<reason>"` and wait for Greg's reply.
Once granted, the new mount applies on your next container spawn — tell
Greg "got write access, ping me to retry" and continue on the next turn.

Use `dev-access list` to see what is currently writable. Use
`dev-access clone <owner/repo>` to bring in repos that aren't already
local. Hard rails (NanoClaw self-dir, secret patterns) auto-block.

Some Bash commands (`rm -rf`, `git push --force`, hard reset, etc.)
require Greg's per-command approval. The hook is automatic — you'll
just see a 5–60s pause while he confirms.

The existing `github` skill (gh CLI for `mudislandkid` repos) coexists
with this. Standard flow: read locally → edit (with grant) → branch →
commit → push → `gh pr create`.
```

## Phase 6: Build and restart

```bash
npm run build
launchctl kickstart -k gui/$(id -u)/com.nanoclaw 2>/dev/null \
  || systemctl --user restart nanoclaw 2>/dev/null \
  || echo "Restart NanoClaw manually."
```

## Phase 7: Write rollback script

```bash
cat > ~/.config/nanoclaw/dev-access-rollback.sh <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
echo "Rolling back add-developer-access..."
# Remove SSD root from allowlist
node --input-type=module -e "
  import fs from 'fs';
  import os from 'os';
  import path from 'path';
  const p = path.join(os.homedir(), '.config', 'nanoclaw', 'mount-allowlist.json');
  if (!fs.existsSync(p)) process.exit(0);
  const cfg = JSON.parse(fs.readFileSync(p, 'utf-8'));
  cfg.allowedRoots = cfg.allowedRoots.filter(r =>
    !(r.path === '/Volumes/1tbSSD' && r.requireApproval) &&
    !r.path.startsWith('/Volumes/1tbSSD/')
  );
  fs.writeFileSync(p, JSON.stringify(cfg, null, 2) + '\n');
"
# Strip dev mounts and devAccessEnabled flag from main group config
node --input-type=module -e "
  import Database from 'better-sqlite3';
  const db = new Database('store/messages.db');
  const rows = db.prepare('SELECT jid, container_config FROM registered_groups').all();
  for (const row of rows) {
    if (!row.container_config) continue;
    const cfg = JSON.parse(row.container_config);
    if (cfg.additionalMounts) {
      cfg.additionalMounts = cfg.additionalMounts.filter(m => !m.containerPath?.startsWith('dev/'));
    }
    delete cfg.devAccessEnabled;
    db.prepare('UPDATE registered_groups SET container_config = ? WHERE jid = ?').run(JSON.stringify(cfg), row.jid);
  }
"
# Remove the container skill
rm -rf container/skills/dev-access
echo "Rolled back. Run npm run build and restart NanoClaw."
EOF
chmod +x ~/.config/nanoclaw/dev-access-rollback.sh
```

## Phase 8: Verification

Tell the user:

> "Developer access set up. Try these in your main chat to verify:
> 1. 'Andy, list contents of /workspace/dev' — should show your projects, all read-only.
> 2. 'Andy, edit a comment in <some project>/README.md' — Andy should hit EROFS, request access, and ping me for confirmation. Reply 'yes'.
> 3. After grant, ping Andy again to retry — the edit should land on the next message.
> 4. To rollback: run ~/.config/nanoclaw/dev-access-rollback.sh"
```

- [ ] **Step 2: Commit**

```bash
git add .claude/skills/add-developer-access/SKILL.md
git commit -m "feat(.claude/skills): add-developer-access install skill

One-shot installer that wires devAccessEnabled on main, adds the
SSD root to the mount allowlist with requireApproval, writes the
default dangerous-commands.json, appends CLAUDE.md guidance for
the main group, and writes a rollback script. Idempotent: each
phase detects existing state and asks before overwriting."
```

---

## Phase 17: Smoke Tests + Final Verification

### Task 17.1: Manual end-to-end smoke test

**Files:**
- None (verification only)

- [ ] **Step 1: Run the install skill in a real environment**

From the main NanoClaw repo on Greg's machine, run the new skill via Claude Code:

```
/add-developer-access
```

Expected: each phase reports OK, build passes, NanoClaw restarts.

- [ ] **Step 2: Verify RO mount visibility**

Send to main: "Andy, run `ls /workspace/dev/` and tell me what you see."
Expected: Andy lists project folders. Asking him to `cat` a file works; asking him to `echo > /workspace/dev/test.tmp` returns EROFS.

- [ ] **Step 3: Verify the elevation flow**

Send: "Andy, edit a single comment in the README of one of your favorite small projects."
Expected: Andy reads the file, attempts edit, calls `dev-access request <project> "<reason>"`, you receive a Signal/etc prompt. Reply "yes". Andy reports granted, asks you to ping for retry.
Send: "go ahead."
Expected: Andy completes the edit on the next message.

- [ ] **Step 4: Verify hard-rail block on NanoClaw self-dir**

Send: "Andy, edit `/workspace/dev/nanoclaw/src/index.ts` to add a comment."
Expected: Andy attempts, gets `status:blocked` immediately with no Signal prompt firing. Andy reports this.

- [ ] **Step 5: Verify destructive-command gate**

Send: "Andy, in <some project> please run `rm -rf node_modules` to clean up."
Expected: Hook intercepts, you receive a Signal prompt with the literal command. Reply "yes". Command runs.

- [ ] **Step 6: Verify destructive-deny path**

Send: "Andy, in <some project> please force-push to main."
Expected: Hook intercepts on `git push --force`. Reply "no". Andy reports denial gracefully.

- [ ] **Step 7: Verify list and revoke**

Send: "Andy, what projects can you write to?"
Expected: Andy uses `dev-access list`, replies with the list.
Send: "Drop write access to <granted project>."
Expected: Andy `dev-access revoke`s; you confirm; Andy reports the mount drops on next spawn.

- [ ] **Step 8: Verify hot reload**

On the host, edit `~/.config/nanoclaw/mount-allowlist.json` to add a description note to one entry. Run `tsx bin/nanoclaw-mount-reload.ts`.
Expected: NanoClaw logs "SIGUSR1 received". On the next message, the new description is in effect (best verified by checking Andy's `dev-access list` output if it surfaces descriptions, or by inspecting an audit log entry that quotes the description).

- [ ] **Step 9: Verify rollback**

Run `~/.config/nanoclaw/dev-access-rollback.sh`. Restart NanoClaw.
Expected: `/workspace/dev/` no longer mounts; `dev-access` is no longer on the container PATH; main group's `container_config.devAccessEnabled` is gone.

- [ ] **Step 10: Document any issues**

If any smoke step fails, capture the error in `groups/main/dev-access.log` (handler logs failures), the orchestrator log, and the agent-runner log. File as a follow-up issue/task.

- [ ] **Step 11: Final commit**

After successful smoke testing, no code commit needed (everything was committed per-phase). Optionally annotate the spec with a short "Implemented and verified on 2026-05-02" footer.

```bash
git commit --allow-empty -m "chore: developer-access feature verified end-to-end

All smoke tests in docs/superpowers/plans/2026-05-02-developer-access.md
passed. Feature ready for daily use."
```

---

## Self-review notes

**Spec coverage:**
- Mount layout (RO root + RW overlays): Phase 3 + Phase 9 (mount registration on grant). ✓
- Allowlist `requireApproval` semantics: Phase 1 + Phase 2. ✓
- Cache invalidation: Phase 2.1, used in Phases 9 + 15. ✓
- Hard rails (NanoClaw, blocked patterns, traversal): Phase 6. ✓
- Pending queue + classifier + audit log: Phases 4, 5, 7. ✓
- Channel-agnostic prompts: Phase 9 (deps.sendMessage). ✓
- Reply interception (yes/no consumed before Andy): Phase 10. ✓
- Container skill (CLI + prose): Phase 11. ✓
- Destructive gate (hook + handler + config): Phases 8, 12, 13, 14. ✓
- Hot-reload CLI: Phase 15. ✓
- Install skill + rollback: Phase 16. ✓
- Smoke tests: Phase 17. ✓

**Type consistency:** `RegisteredGroup` shape used in `getMainGroup()` returns `RegisteredGroup & { jid: string }` synthesised from the map key. Each handler call site does the synthesis identically. `ContainerConfig.devAccessEnabled` is the single flag name across types, container-runner, and install skill.

**Out-of-scope items not implemented (matches spec):**
- Mid-conversation container respawn (Option β)
- Multiple GitHub identities
- Other groups beyond main
- Sandbox subdirectory for clones
- Time-limited grants
- Worktree-based consolidation
- Web/desktop dashboard
- LLM-based danger detection

**Open at implementation time (flagged in spec):**
- Apple Container vs Docker bind-mount overlay parity. The plan assumes both honour parent-RO + child-RW correctly. If Apple Container surprises us on this, fall back to Approach 2 from the spec (`/workspace/dev/` RO + `/workspace/dev-rw/<project>/` RW) — a tactical change in Phase 9's `registerMountInGroup` containerPath.
