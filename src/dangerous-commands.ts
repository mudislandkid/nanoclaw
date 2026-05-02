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
