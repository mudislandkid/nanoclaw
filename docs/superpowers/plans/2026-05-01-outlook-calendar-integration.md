# Outlook Calendar Integration — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Outlook calendar read + write tools to the existing `outlook-mcp` server so the container agent can read events, find free time, create solo events directly, and delete/update events with attendee invites via an approval-gated flow.

**Architecture:** Extend the existing `container/outlook-mcp` MCP server. Add `Calendars.ReadWrite` to the OAuth scope (requires user re-auth). New files: `calendar-logic.ts` (pure functions — schemas, free-gap computation, approval rules), `approval-tokens.ts` (HMAC-signed single-use tokens), `calendar-tools.ts` (MCP tool registration that wires logic + tokens + Graph helper). Three host-side files updated for OAuth scope. Skill doc updated for re-auth.

**Tech Stack:** TypeScript, Node.js, `@modelcontextprotocol/sdk`, `zod`, `node:crypto`, `vitest`.

**Spec:** [docs/superpowers/specs/2026-05-01-outlook-calendar-design.md](../specs/2026-05-01-outlook-calendar-design.md)

---

## File Structure

| File | Action | Responsibility |
|---|---|---|
| `container/outlook-mcp/calendar-logic.ts` | Create | Pure functions: zod schemas, `computeFreeGaps`, `shouldRequireApproval`, output formatters. No MCP / no Graph imports |
| `container/outlook-mcp/approval-tokens.ts` | Create | `issueToken`, `verifyAndConsumeToken`, in-memory store with TTL, HMAC signing |
| `container/outlook-mcp/calendar-tools.ts` | Create | `registerCalendarTools(server, graphFetch)` — wires schemas + Graph calls + token gate |
| `container/outlook-mcp/index.ts` | Modify | Add `Calendars.ReadWrite` to refresh scope. Call `registerCalendarTools` |
| `container/outlook-mcp/calendar-logic.test.ts` | Create | Tests for free-gap algorithm, schema validation, approval rule predicate |
| `container/outlook-mcp/approval-tokens.test.ts` | Create | Tests for issuance, verification, single-use, expiry, signature forgery rejection |
| `vitest.config.ts` | Modify | Include `container/outlook-mcp/**/*.test.ts` |
| `setup/outlook-auth.ts` | Modify | Add `Calendars.ReadWrite` to initial OAuth scope |
| `.claude/skills/add-outlook/SKILL.md` | Modify | Add Calendars.ReadWrite to Phase 3 Azure permissions list. Add re-auth section for existing users |
| `groups/main/CLAUDE.md` | Modify | Document calendar tools, recurring-event language convention, approval flow |

---

## Verification Commands

These appear in many tasks; defined here once:

- **Run focused test:** `npx vitest run container/outlook-mcp/<name>.test.ts`
- **Run all tests:** `npm test`
- **Type check (host code only):** `npm run typecheck` — this only covers `src/` per `tsconfig.json`. It does NOT type-check `container/outlook-mcp/` files; those are verified at container build time (Task 12) and through the test suite for pure logic.
- **Format:** runs automatically on commit via husky (no manual step needed)

**Important:** Because `container/outlook-mcp/` is type-checked only at build time, treat the test files (`calendar-logic.test.ts`, `approval-tokens.test.ts`) as the primary correctness signal during implementation. The container build in Task 12 catches any remaining type errors before runtime.

---

## Task 1: Vitest config — include container tests

**Files:**
- Modify: `vitest.config.ts`

- [ ] **Step 1: Update vitest include glob**

Replace `vitest.config.ts` with:

```typescript
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: [
      'src/**/*.test.ts',
      'setup/**/*.test.ts',
      'container/**/*.test.ts',
    ],
  },
});
```

- [ ] **Step 2: Verify no tests yet match in container/**

Run: `npm test`
Expected: passes — no `container/**/*.test.ts` files exist yet so the glob matches nothing.

- [ ] **Step 3: Commit**

```bash
git add vitest.config.ts
git commit -m "chore: include container tests in vitest run"
```

---

## Task 2: Approval token module — TDD

**Files:**
- Create: `container/outlook-mcp/approval-tokens.ts`
- Create: `container/outlook-mcp/approval-tokens.test.ts`

- [ ] **Step 1: Write failing tests**

Create `container/outlook-mcp/approval-tokens.test.ts`:

```typescript
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
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run container/outlook-mcp/approval-tokens.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the module**

Create `container/outlook-mcp/approval-tokens.ts`:

```typescript
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
      const id = crypto.randomBytes(16).toString('hex');
      const signature = sign(id, kind, payload);
      items.set(id, {
        kind,
        payload,
        expiresAt: Date.now() + opts.ttlMs,
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
      if (stored.signature !== sig) throw new Error('token_expired_or_invalid');
      // single-use: delete on consume regardless of outcome below
      items.delete(id);
      return { kind: stored.kind, payload: stored.payload };
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run container/outlook-mcp/approval-tokens.test.ts`
Expected: PASS — 6 tests passing.

- [ ] **Step 5: Commit**

```bash
git add container/outlook-mcp/approval-tokens.ts container/outlook-mcp/approval-tokens.test.ts
git commit -m "feat(outlook-mcp): add approval token store for calendar writes"
```

---

## Task 3: Calendar logic — schemas + free-gap computation + approval predicate

**Files:**
- Create: `container/outlook-mcp/calendar-logic.ts`
- Create: `container/outlook-mcp/calendar-logic.test.ts`

This task has THREE concerns. Each gets its own test block, but all share one file because they're tightly coupled (schemas reference types defined alongside).

- [ ] **Step 1: Write failing tests**

Create `container/outlook-mcp/calendar-logic.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import {
  computeFreeGaps,
  shouldRequireApproval,
  createEventSchema,
  updateEventSchema,
  listEventsSchema,
  findFreeTimeSchema,
  respondToInviteSchema,
  type GraphEvent,
} from './calendar-logic.js';

describe('createEventSchema', () => {
  it('accepts a minimal valid payload', () => {
    const result = createEventSchema.safeParse({
      subject: 'Deep work',
      start: '2026-05-02T14:00:00',
      end: '2026-05-02T15:00:00',
    });
    expect(result.success).toBe(true);
  });

  it('rejects payloads with an attendees field (personal-only enforcement)', () => {
    const result = createEventSchema.safeParse({
      subject: 'Meeting',
      start: '2026-05-02T14:00:00',
      end: '2026-05-02T15:00:00',
      attendees: ['someone@example.com'],
    });
    expect(result.success).toBe(false);
  });

  it('defaults isAllDay=false, reminderMinutesBeforeStart=15, showAs=busy', () => {
    const parsed = createEventSchema.parse({
      subject: 'X',
      start: '2026-05-02T14:00:00',
      end: '2026-05-02T15:00:00',
    });
    expect(parsed.isAllDay).toBe(false);
    expect(parsed.reminderMinutesBeforeStart).toBe(15);
    expect(parsed.showAs).toBe('busy');
  });
});

describe('updateEventSchema', () => {
  it('requires eventId, makes other fields optional', () => {
    expect(updateEventSchema.safeParse({ eventId: 'evt-1' }).success).toBe(true);
  });

  it('defaults occurrence to "this"', () => {
    const parsed = updateEventSchema.parse({ eventId: 'evt-1' });
    expect(parsed.occurrence).toBe('this');
  });
});

describe('listEventsSchema', () => {
  it('requires startRange and endRange, defaults top=50', () => {
    const parsed = listEventsSchema.parse({
      startRange: '2026-05-01T00:00:00',
      endRange: '2026-05-08T00:00:00',
    });
    expect(parsed.top).toBe(50);
  });
});

describe('findFreeTimeSchema', () => {
  it('requires range bounds and minDurationMinutes', () => {
    const parsed = findFreeTimeSchema.parse({
      startRange: '2026-05-02T08:00:00',
      endRange: '2026-05-02T18:00:00',
      minDurationMinutes: 30,
    });
    expect(parsed.minDurationMinutes).toBe(30);
  });
});

describe('respondToInviteSchema', () => {
  it('defaults sendResponse=true', () => {
    const parsed = respondToInviteSchema.parse({
      eventId: 'evt-1',
      response: 'accept',
    });
    expect(parsed.sendResponse).toBe(true);
  });
});

describe('shouldRequireApproval', () => {
  it('returns false for events with no attendees', () => {
    const event = { attendees: [] } as unknown as GraphEvent;
    expect(shouldRequireApproval(event)).toBe(false);
  });

  it('returns true for events with one or more attendees', () => {
    const event = {
      attendees: [{ emailAddress: { address: 'x@y.com' } }],
    } as unknown as GraphEvent;
    expect(shouldRequireApproval(event)).toBe(true);
  });

  it('returns false when attendees field is undefined', () => {
    const event = {} as unknown as GraphEvent;
    expect(shouldRequireApproval(event)).toBe(false);
  });
});

describe('computeFreeGaps', () => {
  // Helper: build a GraphEvent with showAs and times
  function evt(start: string, end: string, showAs = 'busy'): GraphEvent {
    return {
      id: `${start}-${end}`,
      subject: 'X',
      start: { dateTime: start, timeZone: 'UTC' },
      end: { dateTime: end, timeZone: 'UTC' },
      showAs,
      attendees: [],
      isAllDay: false,
      isOrganizer: true,
      isCancelled: false,
      type: 'singleInstance',
    } as GraphEvent;
  }

  const dayStart = '2026-05-02T08:00:00Z';
  const dayEnd = '2026-05-02T18:00:00Z';

  it('returns the entire range when calendar is empty', () => {
    const gaps = computeFreeGaps([], dayStart, dayEnd, 30);
    expect(gaps).toEqual([
      { start: dayStart, end: dayEnd, durationMinutes: 600 },
    ]);
  });

  it('returns gaps before, between, and after busy events', () => {
    const events = [
      evt('2026-05-02T09:00:00Z', '2026-05-02T10:00:00Z'),
      evt('2026-05-02T13:00:00Z', '2026-05-02T14:00:00Z'),
    ];
    const gaps = computeFreeGaps(events, dayStart, dayEnd, 0);
    expect(gaps.map((g) => g.durationMinutes)).toEqual([60, 180, 240]);
  });

  it('filters out gaps shorter than minDurationMinutes', () => {
    const events = [
      evt('2026-05-02T08:30:00Z', '2026-05-02T09:00:00Z'),
      evt('2026-05-02T09:15:00Z', '2026-05-02T18:00:00Z'),
    ];
    const gaps = computeFreeGaps(events, dayStart, dayEnd, 30);
    // Gap 1: 8:00-8:30 (30 min) — kept (>= 30)
    // Gap 2: 9:00-9:15 (15 min) — dropped
    expect(gaps).toHaveLength(1);
    expect(gaps[0].durationMinutes).toBe(30);
  });

  it('skips events with showAs="free"', () => {
    const events = [
      evt('2026-05-02T09:00:00Z', '2026-05-02T10:00:00Z', 'free'),
    ];
    const gaps = computeFreeGaps(events, dayStart, dayEnd, 0);
    expect(gaps).toEqual([
      { start: dayStart, end: dayEnd, durationMinutes: 600 },
    ]);
  });

  it('handles back-to-back events (no zero-length gap emitted)', () => {
    const events = [
      evt('2026-05-02T09:00:00Z', '2026-05-02T10:00:00Z'),
      evt('2026-05-02T10:00:00Z', '2026-05-02T11:00:00Z'),
    ];
    const gaps = computeFreeGaps(events, dayStart, dayEnd, 0);
    // Expect: 8-9 (60), 11-18 (420) — no zero between them
    expect(gaps.map((g) => g.durationMinutes)).toEqual([60, 420]);
  });

  it('handles overlapping events by merging busy intervals', () => {
    const events = [
      evt('2026-05-02T09:00:00Z', '2026-05-02T10:30:00Z'),
      evt('2026-05-02T10:00:00Z', '2026-05-02T11:00:00Z'),
    ];
    const gaps = computeFreeGaps(events, dayStart, dayEnd, 0);
    // Busy: 9:00-11:00 (merged). Gaps: 8-9 (60), 11-18 (420)
    expect(gaps.map((g) => g.durationMinutes)).toEqual([60, 420]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run container/outlook-mcp/calendar-logic.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the module**

Create `container/outlook-mcp/calendar-logic.ts`:

```typescript
import { z } from 'zod';

// ---------------------------------------------------------------------------
// Graph event shape (subset we care about)
// ---------------------------------------------------------------------------

export interface GraphEvent {
  id: string;
  subject: string;
  body?: { contentType: string; content: string };
  bodyPreview?: string;
  start: { dateTime: string; timeZone: string };
  end: { dateTime: string; timeZone: string };
  location?: { displayName?: string };
  isAllDay: boolean;
  isOrganizer: boolean;
  isCancelled: boolean;
  showAs: string;
  attendees?: Array<{
    emailAddress: { address: string; name?: string };
    status?: { response: string };
    type?: string;
  }>;
  recurrence?: unknown;
  type: 'singleInstance' | 'occurrence' | 'exception' | 'seriesMaster';
  categories?: string[];
}

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const showAsValues = ['free', 'tentative', 'busy', 'oof', 'workingElsewhere'] as const;

export const listEventsSchema = z.object({
  startRange: z.string().describe('ISO 8601 datetime, inclusive (e.g. 2026-05-01T00:00:00)'),
  endRange: z.string().describe('ISO 8601 datetime, exclusive'),
  calendarId: z.string().optional().describe('Calendar ID. Omit for default calendar'),
  query: z.string().optional().describe('Filter by keyword in subject or body'),
  top: z.number().int().min(1).max(100).default(50),
});

export const getEventSchema = z.object({
  eventId: z.string().describe('The event ID'),
});

export const findFreeTimeSchema = z.object({
  startRange: z.string().describe('ISO 8601 datetime, inclusive'),
  endRange: z.string().describe('ISO 8601 datetime, exclusive'),
  minDurationMinutes: z.number().int().min(1).describe('Minimum gap length to return'),
  calendarId: z.string().optional(),
});

// Strict object — extra fields (like `attendees`) cause validation failure.
export const createEventSchema = z
  .object({
    subject: z.string(),
    start: z.string().describe('ISO 8601 datetime, no timezone — uses container TZ'),
    end: z.string().describe('ISO 8601 datetime, no timezone — uses container TZ'),
    body: z.string().optional(),
    location: z.string().optional(),
    isAllDay: z.boolean().default(false),
    reminderMinutesBeforeStart: z.number().int().min(0).default(15),
    showAs: z.enum(showAsValues).default('busy'),
  })
  .strict();

export const updateEventSchema = z.object({
  eventId: z.string(),
  occurrence: z.enum(['this', 'series']).default('this'),
  subject: z.string().optional(),
  start: z.string().optional(),
  end: z.string().optional(),
  body: z.string().optional(),
  location: z.string().optional(),
  showAs: z.enum(showAsValues).optional(),
});

export const deleteEventSchema = z.object({
  eventId: z.string(),
  occurrence: z.enum(['this', 'series']).default('this'),
});

export const respondToInviteSchema = z.object({
  eventId: z.string(),
  response: z.enum(['accept', 'tentativelyAccept', 'decline']),
  comment: z.string().optional(),
  sendResponse: z.boolean().default(true),
});

export const confirmTokenSchema = z.object({
  previewToken: z.string(),
});

// ---------------------------------------------------------------------------
// Approval predicate
// ---------------------------------------------------------------------------

export function shouldRequireApproval(event: GraphEvent): boolean {
  return (event.attendees?.length ?? 0) > 0;
}

// ---------------------------------------------------------------------------
// Free-gap computation
// ---------------------------------------------------------------------------

export interface FreeGap {
  start: string;
  end: string;
  durationMinutes: number;
}

interface Interval {
  start: number;
  end: number;
}

function mergeIntervals(intervals: Interval[]): Interval[] {
  if (intervals.length === 0) return [];
  const sorted = [...intervals].sort((a, b) => a.start - b.start);
  const merged: Interval[] = [{ ...sorted[0] }];
  for (let i = 1; i < sorted.length; i++) {
    const last = merged[merged.length - 1];
    const cur = sorted[i];
    if (cur.start <= last.end) {
      last.end = Math.max(last.end, cur.end);
    } else {
      merged.push({ ...cur });
    }
  }
  return merged;
}

export function computeFreeGaps(
  events: GraphEvent[],
  rangeStart: string,
  rangeEnd: string,
  minDurationMinutes: number,
): FreeGap[] {
  const startMs = Date.parse(rangeStart);
  const endMs = Date.parse(rangeEnd);

  const busy = mergeIntervals(
    events
      .filter((e) => e.showAs !== 'free' && !e.isCancelled)
      .map((e) => ({
        start: Date.parse(e.start.dateTime.endsWith('Z') ? e.start.dateTime : `${e.start.dateTime}Z`),
        end: Date.parse(e.end.dateTime.endsWith('Z') ? e.end.dateTime : `${e.end.dateTime}Z`),
      }))
      .filter((iv) => iv.end > startMs && iv.start < endMs)
      .map((iv) => ({
        start: Math.max(iv.start, startMs),
        end: Math.min(iv.end, endMs),
      })),
  );

  const gaps: FreeGap[] = [];
  let cursor = startMs;
  for (const iv of busy) {
    if (iv.start > cursor) {
      gaps.push(makeGap(cursor, iv.start));
    }
    cursor = Math.max(cursor, iv.end);
  }
  if (cursor < endMs) {
    gaps.push(makeGap(cursor, endMs));
  }

  return gaps.filter((g) => g.durationMinutes >= minDurationMinutes);
}

function makeGap(startMs: number, endMs: number): FreeGap {
  return {
    start: new Date(startMs).toISOString().replace(/\.\d{3}Z$/, 'Z'),
    end: new Date(endMs).toISOString().replace(/\.\d{3}Z$/, 'Z'),
    durationMinutes: Math.round((endMs - startMs) / 60000),
  };
}

// ---------------------------------------------------------------------------
// Output formatter — converts a Graph event to the shape we expose to the agent
// ---------------------------------------------------------------------------

export function formatEventSummary(e: GraphEvent) {
  return {
    id: e.id,
    subject: e.subject,
    start: e.start?.dateTime,
    end: e.end?.dateTime,
    timeZone: e.start?.timeZone,
    location: e.location?.displayName ?? null,
    isAllDay: e.isAllDay,
    isOrganizer: e.isOrganizer,
    isCancelled: e.isCancelled,
    attendeeCount: e.attendees?.length ?? 0,
    isRecurring: e.type === 'occurrence' || e.type === 'seriesMaster',
    showAs: e.showAs,
    categories: e.categories ?? [],
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run container/outlook-mcp/calendar-logic.test.ts`
Expected: PASS — all schema, approval, and free-gap tests pass.

- [ ] **Step 5: Commit**

```bash
git add container/outlook-mcp/calendar-logic.ts container/outlook-mcp/calendar-logic.test.ts
git commit -m "feat(outlook-mcp): add calendar schemas, approval predicate, free-gap computation"
```

---

## Task 4: Calendar tool registration — direct (read) tools

This task wires the four read-only tools (`list_calendars`, `list_events`, `get_event`, `find_free_time`) to the MCP server. No tests for this layer — pure glue between Graph and MCP, tested via the logic module.

**Files:**
- Create: `container/outlook-mcp/calendar-tools.ts`

- [ ] **Step 1: Create the module skeleton with read tools**

Create `container/outlook-mcp/calendar-tools.ts`:

```typescript
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  listEventsSchema,
  getEventSchema,
  findFreeTimeSchema,
  computeFreeGaps,
  formatEventSummary,
  type GraphEvent,
} from './calendar-logic.js';
import { type ApprovalTokenStore } from './approval-tokens.js';

export type GraphFetch = (
  urlPath: string,
  options?: RequestInit,
) => Promise<Response>;

interface RegisterOpts {
  server: McpServer;
  graphFetch: GraphFetch;
  tokenStore: ApprovalTokenStore;
}

const TZ = process.env.TZ ?? 'UTC';

function jsonResult(data: unknown) {
  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify(data, null, 2),
      },
    ],
  };
}

function calendarBase(calendarId?: string) {
  return calendarId ? `/me/calendars/${encodeURIComponent(calendarId)}` : '/me';
}

async function fetchCalendarView(
  graphFetch: GraphFetch,
  startRange: string,
  endRange: string,
  calendarId: string | undefined,
  query: string | undefined,
  top: number,
): Promise<GraphEvent[]> {
  const select =
    'id,subject,start,end,location,isAllDay,isOrganizer,isCancelled,showAs,attendees,type,categories,bodyPreview';
  const params = new URLSearchParams({
    startDateTime: startRange,
    endDateTime: endRange,
    $select: select,
    $top: String(top),
    $orderby: 'start/dateTime',
  });
  if (query) params.set('$search', `"${query}"`);
  const url = `${calendarBase(calendarId)}/calendarView?${params.toString()}`;

  const headers = { Prefer: `outlook.timezone="${TZ}"` };
  const res = await graphFetch(url, { headers });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`calendarView failed (${res.status}): ${body}`);
  }
  const data = (await res.json()) as { value: GraphEvent[] };
  return data.value ?? [];
}

export function registerCalendarTools({ server, graphFetch, tokenStore }: RegisterOpts): void {
  // Suppress unused-warning until later tasks wire write tools
  void tokenStore;

  // -------------------------------------------------------------------------
  // outlook_list_calendars
  // -------------------------------------------------------------------------
  server.tool(
    'outlook_list_calendars',
    'List all calendars in the mailbox.',
    {},
    async () => {
      const res = await graphFetch('/me/calendars?$select=id,name,isDefaultCalendar,canEdit');
      if (!res.ok) {
        throw new Error(`outlook_list_calendars failed (${res.status}): ${await res.text()}`);
      }
      const data = (await res.json()) as {
        value: Array<{ id: string; name: string; isDefaultCalendar: boolean; canEdit: boolean }>;
      };
      return jsonResult(data.value ?? []);
    },
  );

  // -------------------------------------------------------------------------
  // outlook_list_events
  // -------------------------------------------------------------------------
  server.tool(
    'outlook_list_events',
    'List events within a date range. Returns event summaries (id, subject, start, end, location, attendee count, etc.). Use outlook_get_event for full details.',
    listEventsSchema.shape,
    async (args) => {
      const events = await fetchCalendarView(
        graphFetch,
        args.startRange,
        args.endRange,
        args.calendarId,
        args.query,
        args.top,
      );
      return jsonResult(events.map(formatEventSummary));
    },
  );

  // -------------------------------------------------------------------------
  // outlook_get_event
  // -------------------------------------------------------------------------
  server.tool(
    'outlook_get_event',
    'Get full details of a single event including body, attendees, and recurrence pattern.',
    getEventSchema.shape,
    async (args) => {
      const url = `/me/events/${encodeURIComponent(args.eventId)}`;
      const res = await graphFetch(url, {
        headers: { Prefer: `outlook.timezone="${TZ}"` },
      });
      if (!res.ok) {
        throw new Error(`outlook_get_event failed (${res.status}): ${await res.text()}`);
      }
      const event = (await res.json()) as GraphEvent;
      return jsonResult({
        ...formatEventSummary(event),
        body:
          event.body?.contentType === 'html'
            ? event.body.content.replace(/<[^>]+>/g, '').trim()
            : (event.body?.content ?? ''),
        attendees: (event.attendees ?? []).map((a) => ({
          email: a.emailAddress.address,
          name: a.emailAddress.name,
          response: a.status?.response ?? null,
          type: a.type ?? null,
        })),
        recurrence: event.recurrence ?? null,
      });
    },
  );

  // -------------------------------------------------------------------------
  // outlook_find_free_time
  // -------------------------------------------------------------------------
  server.tool(
    'outlook_find_free_time',
    'Find free gaps in the calendar between a start and end. Useful for scheduling. Returns gaps of at least minDurationMinutes. Note: returns literal calendar gaps — does not respect working hours yet.',
    findFreeTimeSchema.shape,
    async (args) => {
      const events = await fetchCalendarView(
        graphFetch,
        args.startRange,
        args.endRange,
        args.calendarId,
        undefined,
        100,
      );
      const gaps = computeFreeGaps(
        events,
        args.startRange,
        args.endRange,
        args.minDurationMinutes,
      );
      return jsonResult(gaps);
    },
  );
}
```

- [ ] **Step 2: Verify host code still type-checks**

Run: `npm run typecheck`
Expected: PASS. This only covers `src/`; `container/outlook-mcp/calendar-tools.ts` will be verified at build time (Task 12).

- [ ] **Step 3: Run all tests to ensure nothing else broke**

Run: `npm test`
Expected: PASS — existing tests still pass; calendar-logic and approval-tokens tests still pass. No tests cover calendar-tools yet (that's intentional — it's glue).

- [ ] **Step 4: Commit**

```bash
git add container/outlook-mcp/calendar-tools.ts
git commit -m "feat(outlook-mcp): add calendar read tools (list_calendars, list_events, get_event, find_free_time)"
```

---

## Task 5: Direct write tool — `outlook_create_event`

**Files:**
- Modify: `container/outlook-mcp/calendar-tools.ts`

- [ ] **Step 1: Add imports**

Edit the imports block at the top of `container/outlook-mcp/calendar-tools.ts`:

Replace:

```typescript
import {
  listEventsSchema,
  getEventSchema,
  findFreeTimeSchema,
  computeFreeGaps,
  formatEventSummary,
  type GraphEvent,
} from './calendar-logic.js';
```

with:

```typescript
import {
  listEventsSchema,
  getEventSchema,
  findFreeTimeSchema,
  createEventSchema,
  computeFreeGaps,
  formatEventSummary,
  type GraphEvent,
} from './calendar-logic.js';
```

- [ ] **Step 2: Add the create_event tool**

Insert after the `outlook_find_free_time` tool definition (before the closing `}` of `registerCalendarTools`):

```typescript
  // -------------------------------------------------------------------------
  // outlook_create_event — direct write (no attendees by schema)
  // -------------------------------------------------------------------------
  server.tool(
    'outlook_create_event',
    'Create an event on your calendar. Personal-only — does not support inviting other attendees. Use outlook_update_event to modify, outlook_delete_event to cancel.',
    createEventSchema.shape,
    async (args) => {
      const payload = {
        subject: args.subject,
        body: args.body
          ? { contentType: 'Text', content: args.body }
          : undefined,
        start: { dateTime: args.start, timeZone: TZ },
        end: { dateTime: args.end, timeZone: TZ },
        location: args.location ? { displayName: args.location } : undefined,
        isAllDay: args.isAllDay,
        reminderMinutesBeforeStart: args.reminderMinutesBeforeStart,
        showAs: args.showAs,
      };

      const res = await graphFetch('/me/events', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      if (!res.ok) {
        throw new Error(`outlook_create_event failed (${res.status}): ${await res.text()}`);
      }

      const created = (await res.json()) as GraphEvent;
      return jsonResult({
        ...formatEventSummary(created),
        status: 'Event created.',
      });
    },
  );
```

- [ ] **Step 3: Verify host code still type-checks**

Run: `npm run typecheck`
Expected: PASS (host code only — container code verified at build time).

- [ ] **Step 4: Verify schema-level rejection still works**

Run: `npx vitest run container/outlook-mcp/calendar-logic.test.ts`
Expected: PASS — the existing "rejects payloads with an attendees field" test still passes.

- [ ] **Step 5: Commit**

```bash
git add container/outlook-mcp/calendar-tools.ts
git commit -m "feat(outlook-mcp): add outlook_create_event (personal-only)"
```

---

## Task 6: Conditional approval tool — `outlook_update_event`

This tool reads the event first, then either patches directly (no attendees) or returns a preview token (has attendees).

**Files:**
- Modify: `container/outlook-mcp/calendar-tools.ts`

- [ ] **Step 1: Update imports**

Replace the imports block:

```typescript
import {
  listEventsSchema,
  getEventSchema,
  findFreeTimeSchema,
  createEventSchema,
  updateEventSchema,
  confirmTokenSchema,
  computeFreeGaps,
  formatEventSummary,
  shouldRequireApproval,
  type GraphEvent,
} from './calendar-logic.js';
```

- [ ] **Step 2: Add a helper to build the Graph PATCH body from update args**

Insert this helper near `fetchCalendarView` (above `registerCalendarTools`):

```typescript
function buildUpdatePayload(args: {
  subject?: string;
  start?: string;
  end?: string;
  body?: string;
  location?: string;
  showAs?: string;
}): Record<string, unknown> {
  const payload: Record<string, unknown> = {};
  if (args.subject !== undefined) payload.subject = args.subject;
  if (args.body !== undefined) payload.body = { contentType: 'Text', content: args.body };
  if (args.start !== undefined) payload.start = { dateTime: args.start, timeZone: TZ };
  if (args.end !== undefined) payload.end = { dateTime: args.end, timeZone: TZ };
  if (args.location !== undefined) payload.location = { displayName: args.location };
  if (args.showAs !== undefined) payload.showAs = args.showAs;
  return payload;
}

function eventEndpoint(eventId: string, occurrence: 'this' | 'series'): string {
  // Graph treats both occurrences and series masters via /me/events/{id}.
  // For occurrence-only edits, callers should pass the occurrence's id.
  // For series-wide edits, callers should pass the seriesMaster's id.
  // We pass occurrence through unchanged — the agent's instructions tell it
  // which id to use based on user intent.
  void occurrence;
  return `/me/events/${encodeURIComponent(eventId)}`;
}
```

- [ ] **Step 3: Add the update_event + confirm_update tools**

Insert after `outlook_create_event`:

```typescript
  // -------------------------------------------------------------------------
  // outlook_update_event — direct if solo, approval-gated if has attendees
  // -------------------------------------------------------------------------
  server.tool(
    'outlook_update_event',
    'Update an event. If the event has attendees, returns a previewToken; you must call outlook_confirm_update with the token after the user approves on Signal. Solo events update immediately. Recurrence: occurrence="this" (default) edits one occurrence; "series" edits the whole series.',
    updateEventSchema.shape,
    async (args) => {
      const fetchUrl = `/me/events/${encodeURIComponent(args.eventId)}?$select=id,subject,start,end,location,attendees,showAs,isAllDay,isOrganizer,isCancelled,type,categories`;
      const fetchRes = await graphFetch(fetchUrl, {
        headers: { Prefer: `outlook.timezone="${TZ}"` },
      });
      if (!fetchRes.ok) {
        throw new Error(`outlook_update_event fetch failed (${fetchRes.status}): ${await fetchRes.text()}`);
      }
      const event = (await fetchRes.json()) as GraphEvent;

      if (shouldRequireApproval(event)) {
        const previewToken = tokenStore.issue('update_with_attendees', {
          eventId: args.eventId,
          occurrence: args.occurrence,
          subject: args.subject,
          start: args.start,
          end: args.end,
          body: args.body,
          location: args.location,
          showAs: args.showAs,
        });
        return jsonResult({
          previewToken,
          event: formatEventSummary(event),
          proposedChanges: buildUpdatePayload(args),
          status:
            'Event has attendees — show the proposed changes to the user on Signal and call outlook_confirm_update with the previewToken after explicit approval.',
        });
      }

      // Solo event — patch directly
      const patchRes = await graphFetch(eventEndpoint(args.eventId, args.occurrence), {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(buildUpdatePayload(args)),
      });
      if (!patchRes.ok) {
        throw new Error(`outlook_update_event PATCH failed (${patchRes.status}): ${await patchRes.text()}`);
      }
      const updated = (await patchRes.json()) as GraphEvent;
      return jsonResult({
        ...formatEventSummary(updated),
        status: 'Event updated.',
      });
    },
  );

  // -------------------------------------------------------------------------
  // outlook_confirm_update — commit a previously approved attendee-event update
  // -------------------------------------------------------------------------
  server.tool(
    'outlook_confirm_update',
    'Commit an attendee-event update after the user has approved the previewToken on Signal. Only call this with a token returned from outlook_update_event.',
    confirmTokenSchema.shape,
    async (args) => {
      const action = tokenStore.verifyAndConsume(args.previewToken);
      if (action.kind !== 'update_with_attendees') {
        throw new Error('previewToken is not for an update action');
      }
      const p = action.payload as {
        eventId: string;
        occurrence: 'this' | 'series';
        subject?: string;
        start?: string;
        end?: string;
        body?: string;
        location?: string;
        showAs?: string;
      };
      const patchRes = await graphFetch(eventEndpoint(p.eventId, p.occurrence), {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(buildUpdatePayload(p)),
      });
      if (!patchRes.ok) {
        throw new Error(`outlook_confirm_update failed (${patchRes.status}): ${await patchRes.text()}`);
      }
      const updated = (await patchRes.json()) as GraphEvent;
      return jsonResult({
        ...formatEventSummary(updated),
        status: 'Event updated and attendees notified.',
      });
    },
  );
```

- [ ] **Step 4: Verify host code still type-checks**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Run logic tests to confirm approval predicate is unchanged**

Run: `npx vitest run container/outlook-mcp/calendar-logic.test.ts`
Expected: PASS — `shouldRequireApproval` tests still green.

- [ ] **Step 6: Commit**

```bash
git add container/outlook-mcp/calendar-tools.ts
git commit -m "feat(outlook-mcp): add update_event with conditional approval gate"
```

---

## Task 7: Approval-gated tools — `outlook_delete_event`, `outlook_respond_to_invite`

**Files:**
- Modify: `container/outlook-mcp/calendar-tools.ts`

- [ ] **Step 1: Update imports**

Replace the imports block:

```typescript
import {
  listEventsSchema,
  getEventSchema,
  findFreeTimeSchema,
  createEventSchema,
  updateEventSchema,
  deleteEventSchema,
  respondToInviteSchema,
  confirmTokenSchema,
  computeFreeGaps,
  formatEventSummary,
  shouldRequireApproval,
  type GraphEvent,
} from './calendar-logic.js';
```

- [ ] **Step 2: Add the four new tools**

Insert after `outlook_confirm_update`:

```typescript
  // -------------------------------------------------------------------------
  // outlook_delete_event — always approval-gated
  // -------------------------------------------------------------------------
  server.tool(
    'outlook_delete_event',
    'Delete an event. Returns a previewToken — you must show the event details to the user on Signal and call outlook_confirm_delete with the token after explicit approval. Default occurrence is "this" (one occurrence); "series" deletes the whole recurring series.',
    deleteEventSchema.shape,
    async (args) => {
      const fetchUrl = `/me/events/${encodeURIComponent(args.eventId)}?$select=id,subject,start,end,location,attendees,showAs,isAllDay,isOrganizer,isCancelled,type,categories`;
      const fetchRes = await graphFetch(fetchUrl, {
        headers: { Prefer: `outlook.timezone="${TZ}"` },
      });
      if (!fetchRes.ok) {
        throw new Error(`outlook_delete_event fetch failed (${fetchRes.status}): ${await fetchRes.text()}`);
      }
      const event = (await fetchRes.json()) as GraphEvent;

      const previewToken = tokenStore.issue('delete', {
        eventId: args.eventId,
        occurrence: args.occurrence,
      });
      return jsonResult({
        previewToken,
        event: formatEventSummary(event),
        occurrence: args.occurrence,
        status:
          args.occurrence === 'series'
            ? 'WHOLE SERIES will be deleted. Show event to user on Signal and call outlook_confirm_delete only after explicit approval.'
            : 'This occurrence will be deleted. Show event to user on Signal and call outlook_confirm_delete only after explicit approval.',
      });
    },
  );

  // -------------------------------------------------------------------------
  // outlook_confirm_delete
  // -------------------------------------------------------------------------
  server.tool(
    'outlook_confirm_delete',
    'Commit a previously approved delete. Only call this with a previewToken from outlook_delete_event AFTER user has explicitly approved on Signal.',
    confirmTokenSchema.shape,
    async (args) => {
      const action = tokenStore.verifyAndConsume(args.previewToken);
      if (action.kind !== 'delete') {
        throw new Error('previewToken is not for a delete action');
      }
      const p = action.payload as { eventId: string; occurrence: 'this' | 'series' };
      const res = await graphFetch(`/me/events/${encodeURIComponent(p.eventId)}`, {
        method: 'DELETE',
      });
      if (!res.ok && res.status !== 204) {
        throw new Error(`outlook_confirm_delete failed (${res.status}): ${await res.text()}`);
      }
      return jsonResult({
        eventId: p.eventId,
        occurrence: p.occurrence,
        status: 'Event deleted.',
      });
    },
  );

  // -------------------------------------------------------------------------
  // outlook_respond_to_invite — approval-gated (sends RSVP email)
  // -------------------------------------------------------------------------
  server.tool(
    'outlook_respond_to_invite',
    'Respond to a meeting invite (accept / tentative / decline). Sends an RSVP email to the organizer if sendResponse is true. Returns a previewToken — call outlook_confirm_invite_response after the user approves on Signal.',
    respondToInviteSchema.shape,
    async (args) => {
      const fetchUrl = `/me/events/${encodeURIComponent(args.eventId)}?$select=id,subject,start,end,location,attendees,showAs,isAllDay,isOrganizer,isCancelled,type,categories`;
      const fetchRes = await graphFetch(fetchUrl, {
        headers: { Prefer: `outlook.timezone="${TZ}"` },
      });
      if (!fetchRes.ok) {
        throw new Error(`outlook_respond_to_invite fetch failed (${fetchRes.status}): ${await fetchRes.text()}`);
      }
      const event = (await fetchRes.json()) as GraphEvent;

      const previewToken = tokenStore.issue('invite_response', {
        eventId: args.eventId,
        response: args.response,
        comment: args.comment,
        sendResponse: args.sendResponse,
      });
      return jsonResult({
        previewToken,
        event: formatEventSummary(event),
        proposedResponse: args.response,
        comment: args.comment ?? null,
        sendResponse: args.sendResponse,
        status:
          'Show event + proposed response to user on Signal. Call outlook_confirm_invite_response with previewToken after explicit approval.',
      });
    },
  );

  // -------------------------------------------------------------------------
  // outlook_confirm_invite_response
  // -------------------------------------------------------------------------
  server.tool(
    'outlook_confirm_invite_response',
    'Commit a previously approved RSVP. Only call this with a previewToken from outlook_respond_to_invite AFTER user has explicitly approved on Signal.',
    confirmTokenSchema.shape,
    async (args) => {
      const action = tokenStore.verifyAndConsume(args.previewToken);
      if (action.kind !== 'invite_response') {
        throw new Error('previewToken is not for an invite response');
      }
      const p = action.payload as {
        eventId: string;
        response: 'accept' | 'tentativelyAccept' | 'decline';
        comment?: string;
        sendResponse: boolean;
      };
      const path = `/me/events/${encodeURIComponent(p.eventId)}/${p.response}`;
      const res = await graphFetch(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          comment: p.comment ?? '',
          sendResponse: p.sendResponse,
        }),
      });
      if (!res.ok && res.status !== 202) {
        throw new Error(`outlook_confirm_invite_response failed (${res.status}): ${await res.text()}`);
      }
      return jsonResult({
        eventId: p.eventId,
        response: p.response,
        status: 'RSVP sent.',
      });
    },
  );
```

- [ ] **Step 3: Verify host code still type-checks**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 4: Run all tests**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add container/outlook-mcp/calendar-tools.ts
git commit -m "feat(outlook-mcp): add delete_event and respond_to_invite with approval gate"
```

---

## Task 8: Wire calendar tools into the MCP server + bump scopes

**Files:**
- Modify: `container/outlook-mcp/index.ts`

- [ ] **Step 1: Read the current scope line and refresh logic**

Open `container/outlook-mcp/index.ts`. The scope on line 76 reads:

```typescript
    scope: 'https://graph.microsoft.com/Mail.ReadWrite offline_access',
```

- [ ] **Step 2: Update the refresh scope**

Replace that line with:

```typescript
    scope: 'https://graph.microsoft.com/Mail.ReadWrite https://graph.microsoft.com/Calendars.ReadWrite offline_access',
```

- [ ] **Step 3: Wire calendar tools at the bottom of the file**

Find the section near the bottom that reads:

```typescript
// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

const transport = new StdioServerTransport();
await server.connect(transport);
```

Replace it with:

```typescript
// ---------------------------------------------------------------------------
// Calendar tools
// ---------------------------------------------------------------------------

import { createTokenStore } from './approval-tokens.js';
import { registerCalendarTools } from './calendar-tools.js';

const tokenStore = createTokenStore({ ttlMs: 5 * 60 * 1000 });
registerCalendarTools({ server, graphFetch, tokenStore });

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

const transport = new StdioServerTransport();
await server.connect(transport);
```

(Note: the imports must be at the top of the file per ES module rules. After making the change, **move the two `import` lines** up to join the existing imports block at the top.)

- [ ] **Step 4: Verify imports are at the top**

Read the top of `container/outlook-mcp/index.ts` — it should look like:

```typescript
/**
 * Outlook MCP Server
 * ...
 */

import fs from 'fs';
import path from 'path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { createTokenStore } from './approval-tokens.js';
import { registerCalendarTools } from './calendar-tools.js';
```

The bottom section should now be just:

```typescript
// ---------------------------------------------------------------------------
// Calendar tools
// ---------------------------------------------------------------------------

const tokenStore = createTokenStore({ ttlMs: 5 * 60 * 1000 });
registerCalendarTools({ server, graphFetch, tokenStore });

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

const transport = new StdioServerTransport();
await server.connect(transport);
```

- [ ] **Step 5: Verify host code still type-checks**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add container/outlook-mcp/index.ts
git commit -m "feat(outlook-mcp): wire calendar tools, add Calendars.ReadWrite to refresh scope"
```

---

## Task 9: Update host-side OAuth scope (initial auth)

The setup OAuth flow needs `Calendars.ReadWrite` so the user's first (or re-) consent grants the right permissions.

**Files:**
- Modify: `setup/outlook-auth.ts`

- [ ] **Step 1: Read the current scope line**

Open `setup/outlook-auth.ts`. Line 12 reads:

```typescript
const SCOPES = 'Mail.Read Mail.ReadWrite Mail.Send User.Read offline_access';
```

- [ ] **Step 2: Update the scope**

Replace with:

```typescript
const SCOPES = 'Mail.Read Mail.ReadWrite Mail.Send Calendars.ReadWrite User.Read offline_access';
```

- [ ] **Step 3: Type-check**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 4: Run setup tests if any**

Run: `npx vitest run setup/`
Expected: PASS — no existing test asserts the scope string verbatim, but if one does, update it to match.

- [ ] **Step 5: Commit**

```bash
git add setup/outlook-auth.ts
git commit -m "feat(setup): add Calendars.ReadWrite to Outlook OAuth scope"
```

---

## Task 10: Update `/add-outlook` skill — Azure permission + re-auth flow

**Files:**
- Modify: `.claude/skills/add-outlook/SKILL.md`

- [ ] **Step 1: Add `Calendars.ReadWrite` to the Azure permissions list**

Find this section in `.claude/skills/add-outlook/SKILL.md`:

```
9. Go to **API permissions** → **Add a permission** → **Microsoft Graph** → **Delegated permissions**
10. Add these permissions:
    - `Mail.Read`
    - `Mail.ReadWrite`
    - `Mail.Send`
    - `User.Read` (should already be there)
11. Verify all 4 permissions are listed
```

Replace with:

```
9. Go to **API permissions** → **Add a permission** → **Microsoft Graph** → **Delegated permissions**
10. Add these permissions:
    - `Mail.Read`
    - `Mail.ReadWrite`
    - `Mail.Send`
    - `Calendars.ReadWrite`
    - `User.Read` (should already be there)
11. Verify all 5 permissions are listed
```

- [ ] **Step 2: Add a re-auth section near the top of Phase 1**

Find Phase 1's "Check if already configured" section. Just after the `If both exist, skip to Phase 6 (Verify).` line, add a new sub-section:

```
### Check if calendar scope is granted

If tokens exist but calendar scope hasn't been granted yet (existing users upgrading from email-only Outlook), the agent's calendar tools will return 403 errors.

```bash
test -f ~/.outlook-mcp/tokens.json && \
  node -e "
    const fs = require('fs');
    const path = require('path');
    const os = require('os');
    const t = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.outlook-mcp', 'tokens.json'), 'utf-8'));
    fetch('https://graph.microsoft.com/v1.0/me/calendars?\$top=1', {
      headers: { Authorization: 'Bearer ' + t.accessToken }
    }).then(r => console.log(r.status === 200 ? 'CALENDAR_OK' : 'CALENDAR_NEEDS_REAUTH:' + r.status));
  "
```

If the output is `CALENDAR_NEEDS_REAUTH:*`, re-run Phase 4 (OAuth Flow) — this will re-consent with the new `Calendars.ReadWrite` scope. Existing email functionality keeps working through the re-auth.
```

- [ ] **Step 3: Update the Phase 4 description**

Find Phase 4's intro paragraph. Replace it with:

```
Run the OAuth setup with the client ID and secret from Phase 3:

```bash
npx tsx setup/index.ts --step outlook-auth -- --client-id <CLIENT_ID> --client-secret <CLIENT_SECRET>
```

This will:
- Save credentials to `~/.outlook-mcp/`
- Open the browser for Microsoft sign-in
- Request scopes: `Mail.Read`, `Mail.ReadWrite`, `Mail.Send`, `Calendars.ReadWrite`, `User.Read`, `offline_access`
- Start a local server on port 3333 to receive the callback
- Exchange the auth code for access + refresh tokens
- Save tokens to `~/.outlook-mcp/tokens.json`

Wait for `OUTLOOK_AUTH_OK=true`. If it fails, check the error and retry.
```

- [ ] **Step 4: Commit**

```bash
git add .claude/skills/add-outlook/SKILL.md
git commit -m "docs: update add-outlook skill with Calendars.ReadWrite scope and re-auth flow"
```

---

## Task 11: Add agent usage guidance to `groups/main/CLAUDE.md`

This tells Andy *how* to use the calendar tools — when to use which one, the recurring-event language convention, and the approval flow.

**Files:**
- Modify: `groups/main/CLAUDE.md`

- [ ] **Step 1: Read the current file**

Read `groups/main/CLAUDE.md` to understand its structure.

- [ ] **Step 2: Append a calendar section**

Append the following section to the end of `groups/main/CLAUDE.md`:

```markdown

## Outlook Calendar

You have read + write access to Greg's Outlook calendar via these tools (only available when the outlook-mcp server is mounted):

### Reading
- `outlook_list_calendars` — list calendars (most users have one default)
- `outlook_list_events(startRange, endRange, query?, calendarId?)` — events in a range
- `outlook_get_event(eventId)` — full event details including body and attendees
- `outlook_find_free_time(startRange, endRange, minDurationMinutes)` — gaps in the calendar

### Writing — direct (no approval needed)
- `outlook_create_event` — create a solo event on Greg's calendar. **No `attendees` field** by design — the schema rejects it. If Greg asks you to "invite X", explain the calendar tools are personal-only and offer to draft an email instead.
- `outlook_update_event` — for **solo events** this updates immediately. For events that have attendees, see below.

### Writing — approval-gated (always show preview on Signal first)
- `outlook_update_event` on an event with attendees — returns a `previewToken`. Show the proposed changes to Greg, wait for explicit approval ("yes update it" / "go ahead"), then call `outlook_confirm_update({ previewToken })`.
- `outlook_delete_event` — always returns a `previewToken`. Show event details + which occurrence (this one vs. the whole series), wait for explicit approval, then call `outlook_confirm_delete({ previewToken })`.
- `outlook_respond_to_invite` — always returns a `previewToken`. Show event + proposed response, wait for approval, then call `outlook_confirm_invite_response({ previewToken })`.

### Recurring events
- Default for delete/update on a recurring series is `occurrence: "this"` (single occurrence).
- Only pass `occurrence: "series"` if Greg has explicitly said something like "the whole series", "every Tuesday", or "all occurrences".
- When in doubt, default to single occurrence and ask.

### Time references
- All times are interpreted in Greg's local timezone (the container's `TZ` env var).
- Send `start` / `end` as ISO 8601 without an offset (e.g. `2026-05-02T14:00:00`) — the MCP server adds the timezone automatically.

### Approval flow expectations
- An approval-gated tool returns `{ previewToken, ...preview }`.
- You MUST show the preview to Greg on Signal and wait for an explicit affirmative ("yes" / "go ahead" / "do it" / "send it") before calling the corresponding `outlook_confirm_*` tool.
- Tokens expire after 5 minutes. If a token expires, re-issue by calling the original tool again.
- An ambiguous response ("ok") or a question ("what happens if I decline?") is NOT approval — clarify first.
```

- [ ] **Step 3: Commit**

```bash
git add groups/main/CLAUDE.md
git commit -m "docs: add Outlook calendar usage guidance for Andy"
```

---

## Task 12: Rebuild the container and smoke-test

**Files:** none (operational task).

- [ ] **Step 1: Rebuild the agent container**

Run: `./container/build.sh`
Expected: build succeeds, includes the new `calendar-logic.ts`, `calendar-tools.ts`, `approval-tokens.ts` files.

If the build cache holds stale files (per the troubleshooting note in `CLAUDE.md`), prune the builder and re-run. Don't skip this — stale `outlook-mcp/` content will silently leave calendar tools missing inside containers.

- [ ] **Step 2: Re-auth Outlook**

Run the re-auth flow per the updated `/add-outlook` skill. The user (Greg) does this; you do not need to script it. Confirm:

```bash
node -e "
  const fs = require('fs');
  const path = require('path');
  const os = require('os');
  const t = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.outlook-mcp', 'tokens.json'), 'utf-8'));
  fetch('https://graph.microsoft.com/v1.0/me/calendars?\$top=1', {
    headers: { Authorization: 'Bearer ' + t.accessToken }
  }).then(r => console.log(r.status === 200 ? 'CALENDAR_OK' : 'CALENDAR_FAIL:' + r.status));
"
```

Expected: `CALENDAR_OK`.

- [ ] **Step 3: Restart NanoClaw**

Per project memory, always restart after build changes:

```bash
launchctl kickstart -k gui/$(id -u)/com.nanoclaw
```

- [ ] **Step 4: Smoke-test on Signal**

Send Greg a message via Signal:
> "What's on my calendar this week?"

Expected: Andy responds with a list of events for the current week, formatted from `outlook_list_events`.

Send:
> "Block 2pm to 3pm tomorrow for deep work"

Expected: Andy creates the event directly (no approval prompt — solo event) and confirms.

Send:
> "Cancel the 2pm tomorrow"

Expected: Andy shows a preview and asks for explicit approval before deleting.

Send:
> "When am I free this week for an hour?"

Expected: Andy returns gaps from `outlook_find_free_time`.

- [ ] **Step 5: Final commit (if any cleanup)**

If any documentation or comment fixes surface during smoke-testing:

```bash
git add -p
git commit -m "fix: smoke-test cleanup for calendar integration"
```

Otherwise this task closes the work.

---

## Self-review checklist

After all tasks complete:

- [ ] Spec §1 (architecture): covered by Tasks 2-8
- [ ] Spec §2 (OAuth scope): covered by Tasks 8, 9, 10
- [ ] Spec §3 (8 primary + 3 confirm tools): covered by Tasks 4, 5, 6, 7
- [ ] Spec §4 (recurring event default `this`): enforced by `updateEventSchema` and `deleteEventSchema` in calendar-logic.ts
- [ ] Spec §5 (timezone handling): TZ env var read in calendar-tools.ts; Prefer header on calendar reads
- [ ] Spec §6 (find-free-time logic): covered by Task 3 + Task 4
- [ ] Spec §9 (testing strategy): covered by Tasks 2, 3 (logic + token tests; tool registration is glue and exercised via smoke test)
- [ ] Spec §10 (file changes): every file listed has a task
- [ ] Spec §12 (success criteria): smoke-tested in Task 12
