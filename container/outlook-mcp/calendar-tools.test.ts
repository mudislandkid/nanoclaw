import { describe, it, expect, beforeEach } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerCalendarTools, type GraphFetch } from './calendar-tools.js';
import { createTokenStore } from './approval-tokens.js';

/**
 * Boundary tests for the MCP tool registration.
 *
 * The unit tests in calendar-logic.test.ts assert that `createEventSchema`
 * rejects an `attendees` field via direct `safeParse`. Those tests do NOT
 * cover the MCP boundary itself: the SDK has two registration APIs and only
 * one of them preserves `.strict()`.
 *
 * - `server.tool(name, desc, schema.shape, cb)` — internally re-wraps the
 *   shape via `z.object(shape)` (no `.strict()`), so unknown fields are
 *   silently STRIPPED. The handler never sees `attendees`, and the schema's
 *   strict rejection never fires. This is the bug we are guarding against.
 *
 * - `server.registerTool(name, { inputSchema: schema }, cb)` — passes the
 *   full schema through `safeParseAsync` as-is, so `.strict()` is honored
 *   and unknown fields cause the call to be rejected with InvalidParams.
 *
 * These tests drive the real validation path used by the JSON-RPC handler
 * (`validateToolInput`) so a regression to `tool(...shape...)` would fail
 * here even though the unit tests on the schema itself would still pass.
 */

interface InternalServer {
  _registeredTools: Record<string, unknown>;
  validateToolInput(tool: unknown, args: unknown, toolName: string): Promise<unknown>;
}

function setupServer(graphFetch?: GraphFetch): {
  server: McpServer;
  internal: InternalServer;
  tools: Record<string, unknown>;
  tokenStore: ReturnType<typeof createTokenStore>;
} {
  const server = new McpServer({ name: 'outlook-mcp-test', version: '1.0.0' });
  const fetcher: GraphFetch =
    graphFetch ??
    (async () => {
      throw new Error('graphFetch should not be called during input validation');
    });
  const tokenStore = createTokenStore({ ttlMs: 5 * 60 * 1000 });
  registerCalendarTools({ server, graphFetch: fetcher, tokenStore });

  const internal = server as unknown as InternalServer;
  return { server, internal, tools: internal._registeredTools, tokenStore };
}

// Helper: call a registered tool's callback after passing input validation
async function callTool(
  internal: InternalServer,
  tools: Record<string, unknown>,
  toolName: string,
  args: unknown,
): Promise<unknown> {
  const validated = await internal.validateToolInput(
    tools[toolName],
    args,
    toolName,
  );
  // The registered tool object exposes the handler — different SDK versions
  // store it under different keys. Try `callback`, then `cb`, then `handler`.
  const tool = tools[toolName] as Record<string, unknown>;
  const handler = (tool.callback ?? tool.cb ?? tool.handler) as
    | ((args: unknown) => Promise<unknown>)
    | undefined;
  if (!handler) throw new Error('handler not found on tool');
  return handler(validated);
}

// Helper: build a Response object for graphFetch mocks
function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('calendar-tools MCP boundary', () => {
  let internal: InternalServer;
  let tools: Record<string, unknown>;

  beforeEach(() => {
    const setup = setupServer();
    internal = setup.internal;
    tools = setup.tools;
  });

  it('registers all calendar tools', () => {
    expect(Object.keys(tools).sort()).toEqual([
      'outlook_confirm_update',
      'outlook_create_event',
      'outlook_find_free_time',
      'outlook_get_event',
      'outlook_list_calendars',
      'outlook_list_events',
      'outlook_update_event',
    ]);
  });

  describe('outlook_create_event', () => {
    it('REJECTS payloads with an attendees field at the MCP boundary', async () => {
      // This is the load-bearing test. If the implementation regresses to
      // `server.tool(name, desc, createEventSchema.shape, cb)`, the SDK will
      // silently strip `attendees` and this expectation will FAIL — the call
      // will resolve with `attendees` removed instead of rejecting.
      await expect(
        internal.validateToolInput(
          tools.outlook_create_event,
          {
            subject: 'Lunch',
            start: '2026-05-02T12:00:00',
            end: '2026-05-02T13:00:00',
            attendees: ['someone@example.com'],
          },
          'outlook_create_event',
        ),
      ).rejects.toThrow(/attendees/i);
    });

    it('accepts a minimal valid payload and applies defaults', async () => {
      const result = (await internal.validateToolInput(
        tools.outlook_create_event,
        {
          subject: 'Lunch',
          start: '2026-05-02T12:00:00',
          end: '2026-05-02T13:00:00',
        },
        'outlook_create_event',
      )) as Record<string, unknown>;
      expect(result.subject).toBe('Lunch');
      expect(result.isAllDay).toBe(false);
      expect(result.reminderMinutesBeforeStart).toBe(15);
      expect(result.showAs).toBe('busy');
    });

    it('rejects any other unknown field', async () => {
      await expect(
        internal.validateToolInput(
          tools.outlook_create_event,
          {
            subject: 'Lunch',
            start: '2026-05-02T12:00:00',
            end: '2026-05-02T13:00:00',
            extraFieldThatShouldNotExist: true,
          },
          'outlook_create_event',
        ),
      ).rejects.toThrow(/extraFieldThatShouldNotExist/);
    });
  });

  describe('outlook_list_events', () => {
    it('parses a minimal valid payload and applies the default top=50', async () => {
      const result = (await internal.validateToolInput(
        tools.outlook_list_events,
        {
          startRange: '2026-05-01T00:00:00',
          endRange: '2026-05-08T00:00:00',
        },
        'outlook_list_events',
      )) as Record<string, unknown>;
      expect(result.top).toBe(50);
    });
  });
});

describe('outlook_update_event', () => {
  it('REJECTS unknown fields at the MCP boundary', async () => {
    const { internal, tools } = setupServer();
    await expect(
      internal.validateToolInput(
        tools.outlook_update_event,
        { eventId: 'evt-1', attendees: ['x@y.com'] },
        'outlook_update_event',
      ),
    ).rejects.toThrow(/attendees/i);
  });

  it('returns a previewToken when event has attendees (no PATCH issued)', async () => {
    const calls: string[] = [];
    const graphFetch: GraphFetch = async (url, options) => {
      calls.push(`${(options?.method ?? 'GET')} ${url}`);
      // First call: fetch event — return event with attendees
      if ((options?.method ?? 'GET') === 'GET') {
        return jsonResponse({
          id: 'evt-1',
          subject: 'Meeting',
          start: { dateTime: '2026-05-02T10:00:00', timeZone: 'UTC' },
          end: { dateTime: '2026-05-02T11:00:00', timeZone: 'UTC' },
          showAs: 'busy',
          attendees: [{ emailAddress: { address: 'x@y.com' } }],
          isAllDay: false,
          isOrganizer: true,
          isCancelled: false,
          type: 'singleInstance',
          categories: [],
        });
      }
      throw new Error(`Unexpected call: ${(options?.method ?? 'GET')} ${url}`);
    };

    const { internal, tools } = setupServer(graphFetch);
    const result = (await callTool(internal, tools, 'outlook_update_event', {
      eventId: 'evt-1',
      subject: 'New Subject',
    })) as { content: Array<{ text: string }> };

    const payload = JSON.parse(result.content[0].text);
    expect(payload.previewToken).toMatch(/^[0-9a-f]+\.[0-9a-f]+$/);
    expect(payload.status).toMatch(/has attendees/);
    expect(calls).toHaveLength(1); // only the GET — no PATCH
  });

  it('PATCHes directly when event has no attendees', async () => {
    const calls: string[] = [];
    const graphFetch: GraphFetch = async (url, options) => {
      const method = options?.method ?? 'GET';
      calls.push(`${method} ${url}`);
      if (method === 'GET') {
        return jsonResponse({
          id: 'evt-1',
          subject: 'Solo block',
          start: { dateTime: '2026-05-02T10:00:00', timeZone: 'UTC' },
          end: { dateTime: '2026-05-02T11:00:00', timeZone: 'UTC' },
          showAs: 'busy',
          attendees: [],
          isAllDay: false,
          isOrganizer: true,
          isCancelled: false,
          type: 'singleInstance',
          categories: [],
        });
      }
      if (method === 'PATCH') {
        return jsonResponse({
          id: 'evt-1',
          subject: 'New Subject',
          start: { dateTime: '2026-05-02T10:00:00', timeZone: 'UTC' },
          end: { dateTime: '2026-05-02T11:00:00', timeZone: 'UTC' },
          showAs: 'busy',
          attendees: [],
          isAllDay: false,
          isOrganizer: true,
          isCancelled: false,
          type: 'singleInstance',
          categories: [],
        });
      }
      throw new Error(`Unexpected call: ${method} ${url}`);
    };

    const { internal, tools } = setupServer(graphFetch);
    const result = (await callTool(internal, tools, 'outlook_update_event', {
      eventId: 'evt-1',
      subject: 'New Subject',
    })) as { content: Array<{ text: string }> };

    const payload = JSON.parse(result.content[0].text);
    expect(payload.status).toBe('Event updated.');
    expect(calls.filter((c) => c.startsWith('PATCH'))).toHaveLength(1);
  });
});

describe('outlook_confirm_update', () => {
  it('REJECTS unknown fields at the MCP boundary', async () => {
    const { internal, tools } = setupServer();
    await expect(
      internal.validateToolInput(
        tools.outlook_confirm_update,
        { previewToken: 'abc.def', extra: 'oops' },
        'outlook_confirm_update',
      ),
    ).rejects.toThrow(/extra/);
  });

  it('rejects an invalid previewToken', async () => {
    const { internal, tools } = setupServer();
    await expect(
      callTool(internal, tools, 'outlook_confirm_update', {
        previewToken: 'not-a-real-token',
      }),
    ).rejects.toThrow(/token_expired_or_invalid/);
  });

  it('rejects a token issued for a different action kind', async () => {
    // Issue a delete-kind token directly via the tokenStore, then try to
    // confirm it via the update path
    const { internal, tools, tokenStore } = setupServer();
    const otherKindToken = tokenStore.issue('delete', { eventId: 'evt-1' });
    await expect(
      callTool(internal, tools, 'outlook_confirm_update', {
        previewToken: otherKindToken,
      }),
    ).rejects.toThrow(/not for an update action/);
  });

  it('PATCHes the event when given a valid update token', async () => {
    const calls: string[] = [];
    const graphFetch: GraphFetch = async (url, options) => {
      const method = options?.method ?? 'GET';
      calls.push(`${method} ${url}`);
      if (method === 'PATCH') {
        return jsonResponse({
          id: 'evt-1',
          subject: 'New Subject',
          start: { dateTime: '2026-05-02T10:00:00', timeZone: 'UTC' },
          end: { dateTime: '2026-05-02T11:00:00', timeZone: 'UTC' },
          showAs: 'busy',
          attendees: [{ emailAddress: { address: 'x@y.com' } }],
          isAllDay: false,
          isOrganizer: true,
          isCancelled: false,
          type: 'singleInstance',
          categories: [],
        });
      }
      throw new Error(`Unexpected call: ${method} ${url}`);
    };

    const { internal, tools, tokenStore } = setupServer(graphFetch);
    const token = tokenStore.issue('update_with_attendees', {
      eventId: 'evt-1',
      occurrence: 'this',
      subject: 'New Subject',
    });

    const result = (await callTool(internal, tools, 'outlook_confirm_update', {
      previewToken: token,
    })) as { content: Array<{ text: string }> };

    const payload = JSON.parse(result.content[0].text);
    expect(payload.status).toBe('Event updated and attendees notified.');
    expect(calls.filter((c) => c.startsWith('PATCH'))).toHaveLength(1);
  });
});
