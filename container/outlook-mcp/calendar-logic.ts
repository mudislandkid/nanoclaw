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

export const updateEventSchema = z
  .object({
    eventId: z.string(),
    occurrence: z.enum(['this', 'series']).default('this'),
    subject: z.string().optional(),
    start: z.string().optional(),
    end: z.string().optional(),
    body: z.string().optional(),
    location: z.string().optional(),
    showAs: z.enum(showAsValues).optional(),
  })
  .strict();

export const deleteEventSchema = z
  .object({
    eventId: z.string(),
    occurrence: z.enum(['this', 'series']).default('this'),
  })
  .strict();

export const respondToInviteSchema = z
  .object({
    eventId: z.string(),
    response: z.enum(['accept', 'tentativelyAccept', 'decline']),
    comment: z.string().optional(),
    sendResponse: z.boolean().default(true),
  })
  .strict();

export const confirmTokenSchema = z
  .object({
    previewToken: z.string(),
  })
  .strict();

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

/**
 * Compute free gaps in a calendar range.
 *
 * IMPORTANT: this function assumes all event datetimes are in UTC. Callers
 * MUST request UTC-formatted events from the Graph API by sending
 * `Prefer: outlook.timezone="UTC"` on the calendarView request that produces
 * `events`. Without that header, Graph returns datetimes in the user's
 * calendar timezone with a separate `timeZone` field, which this function
 * does not consult — gaps would be off by the local-UTC offset.
 *
 * @param events events from Graph API (must be UTC-formatted)
 * @param rangeStart ISO 8601 UTC string (with Z suffix or appended Z)
 * @param rangeEnd ISO 8601 UTC string (with Z suffix or appended Z)
 * @param minDurationMinutes minimum gap length to return
 */
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
