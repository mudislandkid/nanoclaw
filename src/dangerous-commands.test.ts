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
      patterns: [
        'rm\\s+(-[a-zA-Z]*[rRf][a-zA-Z]*\\s+|--force\\s+|--recursive\\s+)',
      ],
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
