import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  listEventsSchema,
  getEventSchema,
  findFreeTimeSchema,
  createEventSchema,
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
  timezone: string = TZ,
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

  const headers = { Prefer: `outlook.timezone="${timezone}"` };
  const res = await graphFetch(url, { headers });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`calendarView failed (${res.status}): ${body}`);
  }
  const data = (await res.json()) as { value: GraphEvent[] };
  return data.value ?? [];
}

export function registerCalendarTools({ server, graphFetch, tokenStore }: RegisterOpts): void {
  // tokenStore is wired in here so later tasks (5-7) can use it for write tools
  void tokenStore;

  // ---------------------------------------------------------------------------
  // IMPORTANT: use `server.registerTool` with `inputSchema: <full ZodObject>`
  // (NOT `server.tool` with `<schema>.shape`).
  //
  // The `server.tool(...)` overload that takes a raw shape internally calls
  // `z.object(shape)` WITHOUT `.strict()`, so any `.strict()` enforcement on
  // the original schema is silently dropped at the MCP boundary — unknown
  // keys would be stripped instead of rejected. `registerTool` accepts a
  // full schema and preserves its strict mode. This is essential for the
  // personal-only invariant on create/update/delete (no attendees field).
  // ---------------------------------------------------------------------------

  // -------------------------------------------------------------------------
  // outlook_list_calendars
  // -------------------------------------------------------------------------
  server.registerTool(
    'outlook_list_calendars',
    {
      description: 'List all calendars in the mailbox.',
    },
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
  server.registerTool(
    'outlook_list_events',
    {
      description:
        'List events within a date range. Returns event summaries (id, subject, start, end, location, attendee count, etc.). Use outlook_get_event for full details.',
      inputSchema: listEventsSchema,
    },
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
  server.registerTool(
    'outlook_get_event',
    {
      description:
        'Get full details of a single event including body, attendees, and recurrence pattern.',
      inputSchema: getEventSchema,
    },
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
  // outlook_find_free_time — MUST request UTC (computeFreeGaps requires it)
  // -------------------------------------------------------------------------
  server.registerTool(
    'outlook_find_free_time',
    {
      description:
        'Find free gaps in the calendar between a start and end. Useful for scheduling. Returns gaps of at least minDurationMinutes. Note: returns literal calendar gaps — does not respect working hours yet.',
      inputSchema: findFreeTimeSchema,
    },
    async (args) => {
      const events = await fetchCalendarView(
        graphFetch,
        args.startRange,
        args.endRange,
        args.calendarId,
        undefined,
        100,
        'UTC',
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

  // -------------------------------------------------------------------------
  // outlook_create_event — direct write (no attendees by schema)
  // -------------------------------------------------------------------------
  server.registerTool(
    'outlook_create_event',
    {
      description:
        'Create an event on your calendar. Personal-only — does not support inviting other attendees. Use outlook_update_event to modify, outlook_delete_event to cancel.',
      inputSchema: createEventSchema,
    },
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
}
