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
