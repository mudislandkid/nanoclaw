import crypto from 'node:crypto';

export type PendingActionKind =
  | 'delete'
  | 'invite_response'
  | 'update_with_attendees';

export interface PendingAction {
  kind: PendingActionKind;
  payload: Record<string, unknown>;
}

interface StoredAction {
  kind: PendingActionKind;
  payload: Record<string, unknown>;
  expiresAt: number;
  signature: string;
}

export interface ApprovalTokenStore {
  issue(kind: PendingActionKind, payload: Record<string, unknown>): string;
  verifyAndConsume(token: string): PendingAction;
}

interface StoreOptions {
  ttlMs: number;
}

export function createTokenStore(opts: StoreOptions): ApprovalTokenStore {
  const secret = crypto.randomBytes(32);
  const items = new Map<string, StoredAction>();

  function sign(id: string, kind: string, payload: Record<string, unknown>): string {
    return crypto
      .createHmac('sha256', secret)
      .update(`${id}|${kind}|${JSON.stringify(payload)}`)
      .digest('hex');
  }

  return {
    issue(kind, payload) {
      // Opportunistic GC sweep: prevents unbounded memory growth from
      // approval prompts that are issued but never consumed.
      const now = Date.now();
      for (const [k, v] of items) {
        if (v.expiresAt < now) items.delete(k);
      }
      const id = crypto.randomBytes(16).toString('hex');
      const signature = sign(id, kind, payload);
      items.set(id, {
        kind,
        payload,
        expiresAt: now + opts.ttlMs,
        signature,
      });
      return `${id}.${signature}`;
    },

    verifyAndConsume(token) {
      const [id, sig] = token.split('.');
      if (!id || !sig) throw new Error('token_expired_or_invalid');
      const stored = items.get(id);
      if (!stored) throw new Error('token_expired_or_invalid');
      if (stored.expiresAt < Date.now()) {
        items.delete(id);
        throw new Error('token_expired_or_invalid');
      }
      if (stored.signature !== sig) {
        // Drop the entry on any signature mismatch — closes the window for
        // an attacker who somehow guessed `id` from probing signatures.
        items.delete(id);
        throw new Error('token_expired_or_invalid');
      }
      // single-use: delete on consume regardless of outcome below
      items.delete(id);
      return { kind: stored.kind, payload: stored.payload };
    },
  };
}
