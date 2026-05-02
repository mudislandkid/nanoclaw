import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import { PassThrough } from 'stream';
import fs from 'fs';
import os from 'os';
import path from 'path';

// Sentinel markers must match container-runner.ts
const OUTPUT_START_MARKER = '---NANOCLAW_OUTPUT_START---';
const OUTPUT_END_MARKER = '---NANOCLAW_OUTPUT_END---';

// Mock config
vi.mock('./config.js', () => ({
  CONTAINER_IMAGE: 'nanoclaw-agent:latest',
  CONTAINER_MAX_OUTPUT_SIZE: 10485760,
  CONTAINER_TIMEOUT: 1800000, // 30min
  CREDENTIAL_PROXY_PORT: 3001,
  DATA_DIR: '/tmp/nanoclaw-test-data',
  GROUPS_DIR: '/tmp/nanoclaw-test-groups',
  IDLE_TIMEOUT: 1800000, // 30min
  TIMEZONE: 'America/Los_Angeles',
}));

// Mock logger
vi.mock('./logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// Mock fs
vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    default: {
      ...actual,
      existsSync: vi.fn(() => false),
      mkdirSync: vi.fn(),
      writeFileSync: vi.fn(),
      readFileSync: vi.fn(() => ''),
      readdirSync: vi.fn(() => []),
      statSync: vi.fn(() => ({ isDirectory: () => false })),
      copyFileSync: vi.fn(),
    },
  };
});

// Mock mount-security
vi.mock('./mount-security.js', () => ({
  validateAdditionalMounts: vi.fn(() => []),
}));

// Create a controllable fake ChildProcess
function createFakeProcess() {
  const proc = new EventEmitter() as EventEmitter & {
    stdin: PassThrough;
    stdout: PassThrough;
    stderr: PassThrough;
    kill: ReturnType<typeof vi.fn>;
    pid: number;
  };
  proc.stdin = new PassThrough();
  proc.stdout = new PassThrough();
  proc.stderr = new PassThrough();
  proc.kill = vi.fn();
  proc.pid = 12345;
  return proc;
}

let fakeProc: ReturnType<typeof createFakeProcess>;

// Mock child_process.spawn
vi.mock('child_process', async () => {
  const actual =
    await vi.importActual<typeof import('child_process')>('child_process');
  return {
    ...actual,
    spawn: vi.fn(() => fakeProc),
    exec: vi.fn(
      (_cmd: string, _opts: unknown, cb?: (err: Error | null) => void) => {
        if (cb) cb(null);
        return new EventEmitter();
      },
    ),
  };
});

import {
  runContainerAgent,
  buildVolumeMounts,
  ContainerOutput,
} from './container-runner.js';
import type { RegisteredGroup } from './types.js';

const testGroup: RegisteredGroup = {
  name: 'Test Group',
  folder: 'test-group',
  trigger: '@Andy',
  added_at: new Date().toISOString(),
};

const testInput = {
  prompt: 'Hello',
  groupFolder: 'test-group',
  chatJid: 'test@g.us',
  isMain: false,
};

function emitOutputMarker(
  proc: ReturnType<typeof createFakeProcess>,
  output: ContainerOutput,
) {
  const json = JSON.stringify(output);
  proc.stdout.push(`${OUTPUT_START_MARKER}\n${json}\n${OUTPUT_END_MARKER}\n`);
}

describe('container-runner timeout behavior', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    fakeProc = createFakeProcess();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('timeout after output resolves as success', async () => {
    const onOutput = vi.fn(async () => {});
    const resultPromise = runContainerAgent(
      testGroup,
      testInput,
      () => {},
      onOutput,
    );

    // Emit output with a result
    emitOutputMarker(fakeProc, {
      status: 'success',
      result: 'Here is my response',
      newSessionId: 'session-123',
    });

    // Let output processing settle
    await vi.advanceTimersByTimeAsync(10);

    // Fire the hard timeout (IDLE_TIMEOUT + 30s = 1830000ms)
    await vi.advanceTimersByTimeAsync(1830000);

    // Emit close event (as if container was stopped by the timeout)
    fakeProc.emit('close', 137);

    // Let the promise resolve
    await vi.advanceTimersByTimeAsync(10);

    const result = await resultPromise;
    expect(result.status).toBe('success');
    expect(result.newSessionId).toBe('session-123');
    expect(onOutput).toHaveBeenCalledWith(
      expect.objectContaining({ result: 'Here is my response' }),
    );
  });

  it('timeout with no output resolves as error', async () => {
    const onOutput = vi.fn(async () => {});
    const resultPromise = runContainerAgent(
      testGroup,
      testInput,
      () => {},
      onOutput,
    );

    // No output emitted — fire the hard timeout
    await vi.advanceTimersByTimeAsync(1830000);

    // Emit close event
    fakeProc.emit('close', 137);

    await vi.advanceTimersByTimeAsync(10);

    const result = await resultPromise;
    expect(result.status).toBe('error');
    expect(result.error).toContain('timed out');
    expect(onOutput).not.toHaveBeenCalled();
  });

  it('normal exit after output resolves as success', async () => {
    const onOutput = vi.fn(async () => {});
    const resultPromise = runContainerAgent(
      testGroup,
      testInput,
      () => {},
      onOutput,
    );

    // Emit output
    emitOutputMarker(fakeProc, {
      status: 'success',
      result: 'Done',
      newSessionId: 'session-456',
    });

    await vi.advanceTimersByTimeAsync(10);

    // Normal exit (no timeout)
    fakeProc.emit('close', 0);

    await vi.advanceTimersByTimeAsync(10);

    const result = await resultPromise;
    expect(result.status).toBe('success');
    expect(result.newSessionId).toBe('session-456');
  });
});

describe('container-runner: devAccessEnabled auto RO root mount', () => {
  const devTestDir = path.join(os.tmpdir(), 'nanoclaw-dev-mount-test');

  // Shared allowlist stub — tests set this before importing the module
  let allowlistStub: import('./types.js').MountAllowlist | null = null;

  beforeEach(() => {
    fs.mkdirSync(devTestDir, { recursive: true });
    allowlistStub = null;
    vi.resetModules();

    // All heavy deps mocked so buildVolumeMounts can run without side effects
    vi.doMock('./config.js', () => ({
      CONTAINER_IMAGE: 'nanoclaw-agent:latest',
      CONTAINER_MAX_OUTPUT_SIZE: 10485760,
      CONTAINER_TIMEOUT: 1800000,
      CREDENTIAL_PROXY_PORT: 3001,
      DATA_DIR: path.join(os.tmpdir(), 'nanoclaw-dev-test-data'),
      GROUPS_DIR: path.join(os.tmpdir(), 'nanoclaw-dev-test-groups'),
      IDLE_TIMEOUT: 1800000,
      TIMEZONE: 'America/Los_Angeles',
      MOUNT_ALLOWLIST_PATH: '/nonexistent/path',
    }));
    vi.doMock('./logger.js', () => ({
      logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    }));
    vi.doMock('./group-folder.js', () => ({
      resolveGroupFolderPath: (folder: string) =>
        path.join(os.tmpdir(), 'nanoclaw-dev-test-groups', folder),
      resolveGroupIpcPath: (folder: string) =>
        path.join(os.tmpdir(), 'nanoclaw-dev-test-ipc', folder),
    }));
    vi.doMock('./env.js', () => ({
      readEnvFile: vi.fn(() => ({})),
    }));
    vi.doMock('./container-runtime.js', () => ({
      CONTAINER_HOST_GATEWAY: '172.17.0.1',
      CONTAINER_RUNTIME_BIN: 'docker',
      hostGatewayArgs: vi.fn(() => []),
      readonlyMountArgs: vi.fn((host: string, container: string) => [
        '--mount',
        `type=bind,source=${host},target=${container},readonly`,
      ]),
      stopContainer: vi.fn(() => 'docker stop test'),
    }));
    vi.doMock('./credential-proxy.js', () => ({
      detectAuthMode: vi.fn(() => 'api-key'),
    }));
    // Mount-security: loadMountAllowlist returns the stub set by each test;
    // expandPath is the real implementation (identity for absolute paths)
    vi.doMock('./mount-security.js', () => ({
      loadMountAllowlist: () => allowlistStub,
      validateAdditionalMounts: () => [],
      invalidateAllowlistCache: () => {},
      expandPath: (p: string) => p, // absolute test paths pass through unchanged
    }));
    // Override fs so that existsSync returns true for the test dev dir.
    // realpathSync returns the path unchanged for known test dirs (no symlinks).
    // The factory must be synchronous for vi.doMock; we use the `fs` import
    // (bound to the top-level mock) and restore all real methods except existsSync.
    vi.doMock('fs', () => ({
      ...fs,
      default: {
        ...fs,
        // Allow the test dev dir to exist; everything else stays false.
        existsSync: (p: string) => p === devTestDir || p.startsWith(devTestDir),
        realpathSync: (p: string) => p, // no symlinks in test paths
        mkdirSync: vi.fn(),
        writeFileSync: vi.fn(),
        readFileSync: vi.fn(() => ''),
        readdirSync: vi.fn(() => []),
        statSync: vi.fn(() => ({ isDirectory: () => false })),
        copyFileSync: vi.fn(),
        cpSync: vi.fn(),
      },
    }));
  });

  afterEach(() => {
    fs.rmSync(devTestDir, { recursive: true, force: true });
    vi.resetModules();
  });

  it('adds RO root mount for each requireApproval allowlist root when devAccessEnabled', async () => {
    // Arrange: allowlist with the test root marked requireApproval
    allowlistStub = {
      allowedRoots: [
        {
          path: devTestDir,
          allowReadWrite: true,
          requireApproval: true,
          description: 'Dev projects root',
        },
      ],
      blockedPatterns: [],
      nonMainReadOnly: true,
    };

    const group = {
      name: 'Dev Group',
      folder: 'dev-group',
      trigger: '@Dev',
      added_at: new Date().toISOString(),
      containerConfig: { devAccessEnabled: true },
    };

    const mod = await import('./container-runner.js');
    const mounts = mod.buildVolumeMounts(group, true);

    const devMount = mounts.find((m) => m.containerPath === '/workspace/dev');
    expect(devMount).toBeDefined();
    expect(devMount!.readonly).toBe(true);
    expect(devMount!.hostPath).toBe(devTestDir);
  });

  it('does not add the auto RO mount when devAccessEnabled is false', async () => {
    // Arrange: same allowlist, but devAccessEnabled = false
    allowlistStub = {
      allowedRoots: [
        {
          path: devTestDir,
          allowReadWrite: true,
          requireApproval: true,
          description: 'Dev projects root',
        },
      ],
      blockedPatterns: [],
      nonMainReadOnly: true,
    };

    const group = {
      name: 'Dev Group',
      folder: 'dev-group',
      trigger: '@Dev',
      added_at: new Date().toISOString(),
      containerConfig: { devAccessEnabled: false },
    };

    const mod = await import('./container-runner.js');
    const mounts = mod.buildVolumeMounts(group, true);

    const devMount = mounts.find((m) => m.containerPath === '/workspace/dev');
    expect(devMount).toBeUndefined();
  });

  it('mounts only the first requireApproval root when multiple exist', async () => {
    // Setup: allowlist with two requireApproval roots.
    // Both paths are under devTestDir so existsSync returns true for both.
    const devTestDir2 = devTestDir + '-second';
    allowlistStub = {
      allowedRoots: [
        {
          path: devTestDir,
          allowReadWrite: true,
          requireApproval: true,
          description: 'First dev root',
        },
        {
          path: devTestDir2,
          allowReadWrite: true,
          requireApproval: true,
          description: 'Second dev root',
        },
      ],
      blockedPatterns: [],
      nonMainReadOnly: true,
    };

    const group = {
      name: 'Dev Group',
      folder: 'dev-group',
      trigger: '@Dev',
      added_at: new Date().toISOString(),
      containerConfig: { devAccessEnabled: true },
    };

    const mod = await import('./container-runner.js');
    const mounts = mod.buildVolumeMounts(group, true);

    // Only the first requireApproval root should produce a /workspace/dev mount
    const devMounts = mounts.filter((m) => m.containerPath === '/workspace/dev');
    expect(devMounts).toHaveLength(1);
    expect(devMounts[0].hostPath).toBe(devTestDir);
  });

  it('skips roots with requireApproval:false even when devAccessEnabled', async () => {
    // Setup: allowlist with a single root that has requireApproval:false.
    allowlistStub = {
      allowedRoots: [
        {
          path: devTestDir,
          allowReadWrite: true,
          requireApproval: false,
          description: 'Non-approval root',
        },
      ],
      blockedPatterns: [],
      nonMainReadOnly: true,
    };

    const group = {
      name: 'Dev Group',
      folder: 'dev-group',
      trigger: '@Dev',
      added_at: new Date().toISOString(),
      containerConfig: { devAccessEnabled: true },
    };

    const mod = await import('./container-runner.js');
    const mounts = mod.buildVolumeMounts(group, true);

    const devMounts = mounts.filter((m) => m.containerPath === '/workspace/dev');
    expect(devMounts).toHaveLength(0);
  });
});
