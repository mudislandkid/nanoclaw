import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
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

// Note: Graph treats both single-occurrences and series-masters via /me/events/{id}.
// The agent passes the occurrence's id (for "this") or the seriesMaster's id (for "series").
// The `occurrence` parameter is metadata for the user-facing preview only.
function eventEndpoint(eventId: string): string {
  return `/me/events/${encodeURIComponent(eventId)}`;
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

  // -------------------------------------------------------------------------
  // outlook_update_event — direct if solo, approval-gated if has attendees
  // -------------------------------------------------------------------------
  server.registerTool(
    'outlook_update_event',
    {
      description:
        'Update an event. If the event has attendees, returns a previewToken; you must call outlook_confirm_update with the token after the user approves on Signal. Solo events update immediately. Recurrence: occurrence="this" (default) edits one occurrence; "series" edits the whole series.',
      inputSchema: updateEventSchema,
    },
    async (args) => {
      const fetchUrl = `/me/events/${encodeURIComponent(args.eventId)}?$select=id,subject,start,end,location,attendees,showAs,isAllDay,isOrganizer,isCancelled,type,categories`;
      const fetchRes = await graphFetch(fetchUrl, {
        headers: { Prefer: `outlook.timezone="${TZ}"` },
      });
      if (!fetchRes.ok) {
        throw new Error(
          `outlook_update_event fetch failed (${fetchRes.status}): ${await fetchRes.text()}`,
        );
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
      const patchRes = await graphFetch(eventEndpoint(args.eventId), {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(buildUpdatePayload(args)),
      });
      if (!patchRes.ok) {
        throw new Error(
          `outlook_update_event PATCH failed (${patchRes.status}): ${await patchRes.text()}`,
        );
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
  server.registerTool(
    'outlook_confirm_update',
    {
      description:
        'Commit an attendee-event update after the user has approved the previewToken on Signal. Only call this with a token returned from outlook_update_event.',
      inputSchema: confirmTokenSchema,
    },
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
      const patchRes = await graphFetch(eventEndpoint(p.eventId), {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(buildUpdatePayload(p)),
      });
      if (!patchRes.ok) {
        throw new Error(
          `outlook_confirm_update failed (${patchRes.status}): ${await patchRes.text()}`,
        );
      }
      const updated = (await patchRes.json()) as GraphEvent;
      return jsonResult({
        ...formatEventSummary(updated),
        status: 'Event updated and attendees notified.',
      });
    },
  );

  // -------------------------------------------------------------------------
  // outlook_delete_event — always approval-gated
  // -------------------------------------------------------------------------
  server.registerTool(
    'outlook_delete_event',
    {
      description:
        'Delete an event. Returns a previewToken — you must show the event details to the user on Signal and call outlook_confirm_delete with the token after explicit approval. Default occurrence is "this" (one occurrence); "series" deletes the whole recurring series.',
      inputSchema: deleteEventSchema,
    },
    async (args) => {
      const fetchUrl = `/me/events/${encodeURIComponent(args.eventId)}?$select=id,subject,start,end,location,attendees,showAs,isAllDay,isOrganizer,isCancelled,type,categories`;
      const fetchRes = await graphFetch(fetchUrl, {
        headers: { Prefer: `outlook.timezone="${TZ}"` },
      });
      if (!fetchRes.ok) {
        throw new Error(
          `outlook_delete_event fetch failed (${fetchRes.status}): ${await fetchRes.text()}`,
        );
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
  server.registerTool(
    'outlook_confirm_delete',
    {
      description:
        'Commit a previously approved delete. Only call this with a previewToken from outlook_delete_event AFTER user has explicitly approved on Signal.',
      inputSchema: confirmTokenSchema,
    },
    async (args) => {
      const action = tokenStore.verifyAndConsume(args.previewToken);
      if (action.kind !== 'delete') {
        throw new Error('previewToken is not for a delete action');
      }
      const p = action.payload as {
        eventId: string;
        occurrence: 'this' | 'series';
      };
      const res = await graphFetch(`/me/events/${encodeURIComponent(p.eventId)}`, {
        method: 'DELETE',
      });
      if (!res.ok && res.status !== 204) {
        throw new Error(
          `outlook_confirm_delete failed (${res.status}): ${await res.text()}`,
        );
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
  server.registerTool(
    'outlook_respond_to_invite',
    {
      description:
        'Respond to a meeting invite (accept / tentative / decline). Sends an RSVP email to the organizer if sendResponse is true. Returns a previewToken — call outlook_confirm_invite_response after the user approves on Signal.',
      inputSchema: respondToInviteSchema,
    },
    async (args) => {
      const fetchUrl = `/me/events/${encodeURIComponent(args.eventId)}?$select=id,subject,start,end,location,attendees,showAs,isAllDay,isOrganizer,isCancelled,type,categories`;
      const fetchRes = await graphFetch(fetchUrl, {
        headers: { Prefer: `outlook.timezone="${TZ}"` },
      });
      if (!fetchRes.ok) {
        throw new Error(
          `outlook_respond_to_invite fetch failed (${fetchRes.status}): ${await fetchRes.text()}`,
        );
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
  server.registerTool(
    'outlook_confirm_invite_response',
    {
      description:
        'Commit a previously approved RSVP. Only call this with a previewToken from outlook_respond_to_invite AFTER user has explicitly approved on Signal.',
      inputSchema: confirmTokenSchema,
    },
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
        throw new Error(
          `outlook_confirm_invite_response failed (${res.status}): ${await res.text()}`,
        );
      }
      return jsonResult({
        eventId: p.eventId,
        response: p.response,
        status: 'RSVP sent.',
      });
    },
  );
}
