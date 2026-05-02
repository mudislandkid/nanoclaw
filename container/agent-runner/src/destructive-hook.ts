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
        } as never;
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
