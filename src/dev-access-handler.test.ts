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
  DANGEROUS_COMMANDS_PATH: path.join(
    tmpRoot,
    'config',
    'dangerous-commands.json',
  ),
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

describe('dev-access-handler: clone flow', () => {
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
    sentMessages.length = 0;
  });

  afterEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('runs cloneRepo on approved clone, then registers mount', async () => {
    const { startDevAccessHandler } = await import('./dev-access-handler.js');

    const cloneCalls: Array<{ owner: string; project: string; dest: string }> =
      [];
    const updateGroupConfigCalls: Array<{ jid: string; group: object }> = [];

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
      getRegisteredGroups: () => ({
        'main-jid': {
          name: 'Main',
          folder: 'main',
          trigger: '@andy',
          added_at: '',
          isMain: true,
          containerConfig: { devAccessEnabled: true },
        },
      }),
      updateGroupConfig: (jid, group) =>
        updateGroupConfigCalls.push({ jid, group }),
      nanoclawDir: '/tmp/nope',
      cloneRepo: async (owner, project, destPath) => {
        cloneCalls.push({ owner, project, dest: destPath });
        // Simulate the clone creating the directory
        fs.mkdirSync(destPath, { recursive: true });
      },
    });

    fs.writeFileSync(
      path.join(ipcDir, 'access-requests', 'c1.json'),
      JSON.stringify({
        id: 'c1',
        command: 'clone',
        project: 'newrepo',
        owner: 'mudislandkid',
        requestedAt: new Date().toISOString(),
      }),
    );

    await new Promise((r) => setTimeout(r, 200));
    await handler.tryConsumeReply('main', 'yes');
    await new Promise((r) => setTimeout(r, 100));

    // cloneRepo was invoked with the right args
    expect(cloneCalls).toHaveLength(1);
    expect(cloneCalls[0].owner).toBe('mudislandkid');
    expect(cloneCalls[0].project).toBe('newrepo');

    // Mount was registered
    expect(updateGroupConfigCalls).toHaveLength(1);
    const additionalMounts =
      (
        updateGroupConfigCalls[0].group as {
          containerConfig?: { additionalMounts?: unknown[] };
        }
      ).containerConfig?.additionalMounts ?? [];
    expect(additionalMounts).toContainEqual(
      expect.objectContaining({
        containerPath: 'newrepo',
        readonly: false,
        devOverlay: true,
      }),
    );

    // Response written with success message
    const responseFile = path.join(ipcDir, 'access-responses', 'c1.json');
    const response = JSON.parse(fs.readFileSync(responseFile, 'utf-8'));
    expect(response.status).toBe('granted');
    expect(response.message).toMatch(/cloned/i);

    handler.stop();
  });

  it('does not register mount when cloneRepo fails', async () => {
    const { startDevAccessHandler } = await import('./dev-access-handler.js');

    const updateGroupConfigCalls: Array<{ jid: string; group: object }> = [];

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
      getRegisteredGroups: () => ({
        'main-jid': {
          name: 'Main',
          folder: 'main',
          trigger: '@andy',
          added_at: '',
          isMain: true,
          containerConfig: { devAccessEnabled: true },
        },
      }),
      updateGroupConfig: (jid, group) =>
        updateGroupConfigCalls.push({ jid, group }),
      nanoclawDir: '/tmp/nope',
      cloneRepo: async (_owner, _project, _destPath) => {
        throw new Error('repo not found');
      },
    });

    fs.writeFileSync(
      path.join(ipcDir, 'access-requests', 'c2.json'),
      JSON.stringify({
        id: 'c2',
        command: 'clone',
        project: 'badrepo',
        owner: 'mudislandkid',
        requestedAt: new Date().toISOString(),
      }),
    );

    await new Promise((r) => setTimeout(r, 200));
    await handler.tryConsumeReply('main', 'yes');
    await new Promise((r) => setTimeout(r, 100));

    // No mount registered
    expect(updateGroupConfigCalls).toHaveLength(0);

    // Response file written with denied status
    const responseFile = path.join(ipcDir, 'access-responses', 'c2.json');
    const response = JSON.parse(fs.readFileSync(responseFile, 'utf-8'));
    expect(response.status).toBe('denied');
    expect(response.message).toMatch(/clone/i);

    handler.stop();
  });
});

describe('dev-access-handler: dangerous-command flow', () => {
  beforeEach(() => {
    fs.mkdirSync(path.join(ipcDir, 'access-requests'), { recursive: true });
    fs.mkdirSync(path.join(ipcDir, 'access-responses'), { recursive: true });
    fs.mkdirSync(path.join(ipcDir, 'dangerous-commands'), { recursive: true });
    fs.mkdirSync(path.join(ipcDir, 'dangerous-responses'), { recursive: true });
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
    sentMessages.length = 0;
  });

  afterEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('prompts and on yes writes approved response', async () => {
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

  it('writes denied response when user replies no', async () => {
    const { startDevAccessHandler } = await import('./dev-access-handler.js');

    const handler = startDevAccessHandler({
      sendMessage: async (jid, text) => { sentMessages.push({ jid, text }); },
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
      path.join(ipcDir, 'dangerous-commands', 'd2.json'),
      JSON.stringify({
        id: 'd2',
        command: 'git push --force origin main',
        cwd: '/workspace/dev/SomeProj',
        requestedAt: new Date().toISOString(),
      }),
    );

    await new Promise((r) => setTimeout(r, 200));
    await handler.tryConsumeReply('main', 'no');
    await new Promise((r) => setTimeout(r, 100));

    const resFile = path.join(ipcDir, 'dangerous-responses', 'd2.json');
    expect(fs.existsSync(resFile)).toBe(true);
    const res = JSON.parse(fs.readFileSync(resFile, 'utf-8'));
    expect(res.status).toBe('denied');

    handler.stop();
  });
});
