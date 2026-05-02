import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

const testDir = path.join(os.tmpdir(), 'nanoclaw-mount-test-vault');
const configDir = path.join(os.tmpdir(), 'nanoclaw-mount-test-config');
const allowlistPath = path.join(configDir, 'mount-allowlist.json');

vi.mock('./config.js', () => ({
  MOUNT_ALLOWLIST_PATH: allowlistPath,
}));

describe('mount-security: overrideNonMainReadOnly', () => {
  beforeEach(async () => {
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

  it('allows read-write for non-main group when overrideNonMainReadOnly is true', async () => {
    const allowlist = {
      allowedRoots: [
        {
          path: testDir,
          allowReadWrite: true,
          overrideNonMainReadOnly: true,
          description: 'Test vault with override',
        },
      ],
      blockedPatterns: [],
      nonMainReadOnly: true,
    };
    fs.writeFileSync(allowlistPath, JSON.stringify(allowlist));

    const mod = await import('./mount-security.js');
    const mounts = mod.validateAdditionalMounts(
      [{ hostPath: testDir, containerPath: 'second-brain', readonly: false }],
      'test-group',
      false,
    );

    expect(mounts).toHaveLength(1);
    expect(mounts[0].readonly).toBe(false);
  });

  it('forces read-only for non-main group when overrideNonMainReadOnly is not set', async () => {
    const allowlist = {
      allowedRoots: [
        { path: testDir, allowReadWrite: true, description: 'No override' },
      ],
      blockedPatterns: [],
      nonMainReadOnly: true,
    };
    fs.writeFileSync(allowlistPath, JSON.stringify(allowlist));

    const mod = await import('./mount-security.js');
    const mounts = mod.validateAdditionalMounts(
      [{ hostPath: testDir, containerPath: 'second-brain', readonly: false }],
      'test-group',
      false,
    );

    expect(mounts).toHaveLength(1);
    expect(mounts[0].readonly).toBe(true);
  });
});

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

  it('forces RO for subdirectory under requireApproval root with no explicit child entry', async () => {
    const subDir = path.join(testDir, 'unlistedDir');
    fs.mkdirSync(subDir, { recursive: true });

    // Parent root has allowReadWrite:true (so the SSD root is technically allowed)
    // and requireApproval:true. The subdir does NOT have its own entry.
    // Result: subdir should be forced RO because it falls under a
    // requireApproval root.
    const allowlist = {
      allowedRoots: [
        { path: testDir, allowReadWrite: true, requireApproval: true },
      ],
      blockedPatterns: [],
      nonMainReadOnly: false,
    };
    fs.writeFileSync(allowlistPath, JSON.stringify(allowlist));

    const mod = await import('./mount-security.js');
    const result = mod.validateMount(
      { hostPath: subDir, containerPath: 'unlistedDir', readonly: false },
      true,
    );

    expect(result.allowed).toBe(true);
    expect(result.effectiveReadonly).toBe(true);
  });
});
