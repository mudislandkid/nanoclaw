import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  createTokenStore,
  type ApprovalTokenStore,
  type PendingActionKind,
} from './approval-tokens.js';

describe('approval tokens', () => {
  let store: ApprovalTokenStore;

  beforeEach(() => {
    store = createTokenStore({ ttlMs: 5 * 60 * 1000 });
  });

  it('issues a token and returns the same payload on consume', () => {
    const token = store.issue('delete', { eventId: 'evt-1' });
    const result = store.verifyAndConsume(token);
    expect(result).toEqual({ kind: 'delete', payload: { eventId: 'evt-1' } });
  });

  it('rejects an unknown token', () => {
    expect(() => store.verifyAndConsume('not-a-real-token')).toThrow(
      /token_expired_or_invalid/,
    );
  });

  it('is single-use — second consume fails', () => {
    const token = store.issue('delete', { eventId: 'evt-1' });
    store.verifyAndConsume(token);
    expect(() => store.verifyAndConsume(token)).toThrow(
      /token_expired_or_invalid/,
    );
  });

  it('expires after TTL', () => {
    vi.useFakeTimers();
    const token = store.issue('delete', { eventId: 'evt-1' });
    vi.advanceTimersByTime(5 * 60 * 1000 + 1);
    expect(() => store.verifyAndConsume(token)).toThrow(
      /token_expired_or_invalid/,
    );
    vi.useRealTimers();
  });

  it('rejects forged tokens with valid prefix but wrong signature', () => {
    const token = store.issue('delete', { eventId: 'evt-1' });
    // Token format: <id>.<signature> — flip a character in the signature
    const [id, sig] = token.split('.');
    const forged = `${id}.${sig.slice(0, -1)}${sig.slice(-1) === 'a' ? 'b' : 'a'}`;
    expect(() => store.verifyAndConsume(forged)).toThrow(
      /token_expired_or_invalid/,
    );
  });

  it('preserves all PendingActionKind variants', () => {
    const kinds: PendingActionKind[] = [
      'delete',
      'invite_response',
      'update_with_attendees',
    ];
    for (const kind of kinds) {
      const token = store.issue(kind, { eventId: 'evt-x' });
      const result = store.verifyAndConsume(token);
      expect(result.kind).toBe(kind);
    }
  });

  it('garbage-collects expired entries on next issue', () => {
    vi.useFakeTimers();
    const t1 = store.issue('delete', { eventId: 'evt-1' });
    vi.advanceTimersByTime(5 * 60 * 1000 + 1);
    // t1 is now expired but still in the map. Issuing a fresh token should sweep it.
    store.issue('delete', { eventId: 'evt-2' });
    // Now t1 should be gone — verifyAndConsume hits the same `unknown id` path
    expect(() => store.verifyAndConsume(t1)).toThrow(
      /token_expired_or_invalid/,
    );
    vi.useRealTimers();
  });

  it('drops the entry after a bad-signature attempt (no repeated guesses)', () => {
    const token = store.issue('delete', { eventId: 'evt-1' });
    const [id, sig] = token.split('.');
    const forged = `${id}.${sig.slice(0, -1)}${sig.slice(-1) === 'a' ? 'b' : 'a'}`;
    // First attempt: bad signature
    expect(() => store.verifyAndConsume(forged)).toThrow(
      /token_expired_or_invalid/,
    );
    // Second attempt with correct token should now also fail because entry is gone
    expect(() => store.verifyAndConsume(token)).toThrow(
      /token_expired_or_invalid/,
    );
  });
});
