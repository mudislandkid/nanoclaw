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
