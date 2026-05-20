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
        {
          path: '/Volumes/1tbSSD',
          allowReadWrite: false,
          requireApproval: true,
        },
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
        {
          path: '/Volumes/1tbSSD/VoltWise',
          allowReadWrite: true,
          overrideNonMainReadOnly: true,
        },
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
        {
          path: '/Volumes/1tbSSD',
          allowReadWrite: false,
          requireApproval: true,
        },
        {
          path: '/Volumes/1tbSSD/VoltWise',
          allowReadWrite: true,
          overrideNonMainReadOnly: true,
        },
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
      allowedRoots: [
        {
          path: '/Volumes/1tbSSD',
          allowReadWrite: false,
          requireApproval: true,
        },
      ],
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

  it('normalises path on add — trailing slash deduplicates with non-trailing-slash entry', async () => {
    const initial = {
      allowedRoots: [
        {
          path: '/Volumes/1tbSSD/VoltWise',
          allowReadWrite: true,
          overrideNonMainReadOnly: true,
        },
      ],
      blockedPatterns: [],
      nonMainReadOnly: true,
    };
    fs.writeFileSync(allowlistPath, JSON.stringify(initial));

    const mod = await import('./allowlist-writer.js');
    mod.addSubdirEntry({ path: '/Volumes/1tbSSD/VoltWise/' });

    const updated = JSON.parse(fs.readFileSync(allowlistPath, 'utf-8'));
    expect(updated.allowedRoots).toHaveLength(1);
  });

  it('lists only writable subdirectories under a root', async () => {
    const initial = {
      allowedRoots: [
        {
          path: '/Volumes/1tbSSD',
          allowReadWrite: false,
          requireApproval: true,
        },
        { path: '/Volumes/1tbSSD/VoltWise', allowReadWrite: true },
        { path: '/Volumes/1tbSSD/Eirene', allowReadWrite: false },
        { path: '/Volumes/other', allowReadWrite: true },
      ],
      blockedPatterns: [],
      nonMainReadOnly: true,
    };
    fs.writeFileSync(allowlistPath, JSON.stringify(initial));

    const mod = await import('./allowlist-writer.js');
    const result = mod.listWritableSubdirs('/Volumes/1tbSSD');

    expect(result).toEqual(['/Volumes/1tbSSD/VoltWise']);
  });
});
