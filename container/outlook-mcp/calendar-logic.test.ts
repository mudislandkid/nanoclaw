import { describe, it, expect } from 'vitest';
import {
  computeFreeGaps,
  shouldRequireApproval,
  createEventSchema,
  updateEventSchema,
  deleteEventSchema,
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

  it('rejects payloads with an attendees field (personal-only enforcement)', () => {
    const result = updateEventSchema.safeParse({
      eventId: 'evt-1',
      attendees: ['someone@example.com'],
    });
    expect(result.success).toBe(false);
  });
});

describe('deleteEventSchema', () => {
  it('accepts a minimal valid payload', () => {
    const parsed = deleteEventSchema.parse({ eventId: 'evt-1' });
    expect(parsed.occurrence).toBe('this');
  });

  it('rejects unknown extra fields', () => {
    const result = deleteEventSchema.safeParse({
      eventId: 'evt-1',
      attendees: ['someone@example.com'],
    });
    expect(result.success).toBe(false);
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
