import { describe, it, expect, beforeEach } from 'vitest';
import { PendingQueue, PendingRequest } from './pending-queue.js';

const baseRequest = (over: Partial<PendingRequest> = {}): PendingRequest => ({
  id: 'r1',
  groupFolder: 'main',
  command: 'request',
  project: 'VoltWise',
  reason: 'fix bug',
  requestedAt: '2026-05-02T10:00:00Z',
  ...over,
});

describe('PendingQueue', () => {
  let queue: PendingQueue;

  beforeEach(() => {
    queue = new PendingQueue();
  });

  it('enqueues and dequeues FIFO per group', () => {
    queue.add(baseRequest({ id: 'r1', project: 'A' }));
    queue.add(baseRequest({ id: 'r2', project: 'B' }));
    expect(queue.peekOldest('main')?.id).toBe('r1');
  });

  it('resolves and removes the oldest', () => {
    queue.add(baseRequest({ id: 'r1', project: 'A' }));
    queue.add(baseRequest({ id: 'r2', project: 'B' }));
    const resolved = queue.resolveOldest('main');
    expect(resolved?.id).toBe('r1');
    expect(queue.peekOldest('main')?.id).toBe('r2');
  });

  it('resolves by project name when disambiguated', () => {
    queue.add(baseRequest({ id: 'r1', project: 'VoltWise' }));
    queue.add(baseRequest({ id: 'r2', project: 'Eirene' }));
    const resolved = queue.resolveByProject('main', 'Eirene');
    expect(resolved?.id).toBe('r2');
    expect(queue.peekOldest('main')?.id).toBe('r1');
  });

  it('returns null when no requests exist for the group', () => {
    expect(queue.peekOldest('main')).toBeNull();
    expect(queue.resolveOldest('main')).toBeNull();
  });

  it('lists all pending requests for a group', () => {
    queue.add(baseRequest({ id: 'r1', project: 'A' }));
    queue.add(baseRequest({ id: 'r2', project: 'B' }));
    expect(queue.list('main').map((r) => r.id)).toEqual(['r1', 'r2']);
  });

  it('expires requests older than maxAgeMs', () => {
    const now = Date.now();
    const old = new Date(now - 10 * 60 * 1000).toISOString();
    const fresh = new Date(now - 1 * 60 * 1000).toISOString();
    queue.add(baseRequest({ id: 'r-old', requestedAt: old }));
    queue.add(baseRequest({ id: 'r-fresh', requestedAt: fresh }));
    const expired = queue.expireOlderThan(now - 5 * 60 * 1000);
    expect(expired.map((r) => r.id)).toEqual(['r-old']);
    expect(queue.list('main').map((r) => r.id)).toEqual(['r-fresh']);
  });
});
