import fs from 'fs';
import path from 'path';

export type AuditAction =
  | 'grant'
  | 'revoke'
  | 'clone'
  | 'request-blocked'
  | 'timeout'
  | 'dangerous-approved'
  | 'dangerous-denied'
  | 'dangerous-blocked';

export type AuditSource =
  | 'signal-reply'
  | 'manual-edit'
  | 'auto-block'
  | 'timeout';

export interface AuditEntry {
  timestamp: string;
  action: AuditAction;
  project?: string;
  source: AuditSource;
  details?: Record<string, unknown>;
}

export function appendAuditEntry(filePath: string, entry: AuditEntry): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const line = JSON.stringify(entry) + '\n';
  fs.appendFileSync(filePath, line, { encoding: 'utf-8' });
}
