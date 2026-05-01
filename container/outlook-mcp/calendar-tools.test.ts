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

function setupServer(): {
  server: McpServer;
  internal: InternalServer;
  tools: Record<string, unknown>;
} {
  const server = new McpServer({ name: 'outlook-mcp-test', version: '1.0.0' });
  // graphFetch shouldn't be reached in input-validation tests
  const graphFetch: GraphFetch = async () => {
    throw new Error('graphFetch should not be called during input validation');
  };
  const tokenStore = createTokenStore({ ttlMs: 5 * 60 * 1000 });
  registerCalendarTools({ server, graphFetch, tokenStore });

  const internal = server as unknown as InternalServer;
  return { server, internal, tools: internal._registeredTools };
}

describe('calendar-tools MCP boundary', () => {
  let internal: InternalServer;
  let tools: Record<string, unknown>;

  beforeEach(() => {
    const setup = setupServer();
    internal = setup.internal;
    tools = setup.tools;
  });

  it('registers all five calendar tools', () => {
    expect(Object.keys(tools).sort()).toEqual([
      'outlook_create_event',
      'outlook_find_free_time',
      'outlook_get_event',
      'outlook_list_calendars',
      'outlook_list_events',
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
