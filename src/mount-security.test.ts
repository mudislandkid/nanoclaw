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
      allowedRoots: [{ path: testDir, allowReadWrite: true, description: 'No override' }],
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
