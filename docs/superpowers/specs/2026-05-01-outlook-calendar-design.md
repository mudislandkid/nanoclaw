# Outlook Calendar Integration — Design

> **Status:** approved 2026-05-01
>
> **Goal:** Give the container agent (Andy) read + write access to the user's Outlook calendar via the existing Microsoft Graph integration, with safe defaults and a clear approval boundary for actions that send email or destroy data.
>
> **Motivation:** ADHD-friendly day management — Andy should be able to read the day's structure, find free time, block focus periods, and reschedule events on demand.

---

## 1. Architecture

Calendar tools are added to the **existing `outlook-mcp` MCP server** in `container/outlook-mcp/`. They share the auth, token refresh, and Graph helper with the email tools. No new MCP server.

**Why not a separate server:** the Microsoft Graph endpoints, OAuth client, refresh logic, and credential mount are all the same. Splitting would duplicate `loadCredentials`, `ensureValidToken`, and `graphFetch` for no benefit. Tool name prefixes (`outlook_search_emails` vs `outlook_list_events`) keep the namespaces clean.

**File layout (keeps `index.ts` under 500 lines):**

```
container/outlook-mcp/
  index.ts             # MCP server bootstrap, auth, graph helper, email tools
  calendar.ts          # NEW — calendar tool implementations
  approval-tokens.ts   # NEW — issue + verify approval tokens
  calendar.test.ts     # NEW — unit tests for tool logic + approval flow
```

The new files keep `index.ts` from growing past the 500-line guideline.

---

## 2. OAuth scope change

| | Before | After |
|---|---|---|
| Scope | `Mail.ReadWrite offline_access` | `Mail.ReadWrite Calendars.ReadWrite offline_access` |

**Re-auth required.** Existing refresh tokens are scope-locked — Microsoft will not return a calendar-scoped access token from a mail-scoped refresh token. The existing user must re-run `/add-outlook` once after upgrade. The skill detects existing tokens and prompts: *"Calendar scope added. Re-authenticate to enable calendar access. Email tools keep working through the transition."*

The `Mail.ReadWrite` capability survives the re-auth — only the refresh token is replaced.

**App registration:** the Azure App Registration must already permit the `Calendars.ReadWrite` delegated permission. The setup skill update notes this — for personal accounts (`consumers` tenant) this is enabled by default for new app registrations, but existing apps may need it added in the Azure portal.

---

## 3. Tools

Eight primary tools, plus three confirmation tools used to commit approval-gated actions (11 MCP tools registered total). Named `outlook_*` to match existing convention.

| Tool | Approval | Purpose |
|---|---|---|
| `outlook_list_calendars` | direct | List calendars in the mailbox (id, name, isDefaultCalendar) |
| `outlook_list_events` | direct | List events in a date range. Optional: `calendarId`, `query` (filter by subject/body keyword) |
| `outlook_get_event` | direct | Full event details by ID — body, location, attendees, recurrence pattern |
| `outlook_find_free_time` | direct | Compute free gaps in a date range. Inputs: `startRange`, `endRange`, `minDurationMinutes`. Returns array of gap objects |
| `outlook_create_event` | direct | Create event on user's calendar. No `attendees` parameter — enforces personal-only at the schema level |
| `outlook_update_event` | **conditional** | Direct if event has zero attendees; **approval-gated** (returns previewToken) if attendees > 0, since Graph sends update notifications |
| `outlook_delete_event` | **approval-gated** | Two-step: returns previewToken; commit via `outlook_confirm_delete(previewToken)` |
| `outlook_respond_to_invite` | **approval-gated** | Two-step: returns previewToken; commit via `outlook_confirm_invite_response(previewToken)`. Sends RSVP email to organizer |

### Approval-gated pattern

Mirrors the existing email `draft_reply` → `send_draft` flow, but with an explicit server-issued token rather than relying on the agent to remember an ID.

```
1. Agent calls outlook_delete_event({ eventId, occurrence?: 'this' | 'series' })
2. Server returns: { previewToken, event: {...summary...}, status: "Show to user. Call outlook_confirm_delete with previewToken." }
3. Agent shows preview to user on Signal, waits for explicit approval
4. Agent calls outlook_confirm_delete({ previewToken })
5. Server validates token (single-use, 5 min TTL), executes the delete, invalidates token
```

Tokens are stored in an in-memory `Map<token, pendingAction>`:

```typescript
interface PendingAction {
  kind: 'delete' | 'invite_response' | 'update_with_attendees';
  payload: object;       // tool-specific args
  createdAt: number;     // for TTL eviction
  signature: string;     // HMAC of (kind + payload + createdAt) using a per-process key
}
```

The signature prevents an agent from forging a token. The map is cleared at process restart, which is acceptable — the agent will simply re-issue.

**Why not just trust the agent's tool-call discipline (like email's draft + send)?** Because Andy will run as multiple parallel containers and across long sessions, drift is possible. The token gate is deterministic; the model cannot accidentally bypass it.

---

## 4. Recurring events

Default for any write operation on a recurring event: **"this occurrence only."**

`outlook_update_event` and `outlook_delete_event` accept an optional `occurrence: 'this' | 'series'` parameter, defaulting to `'this'`. The preview returned to the user explicitly states which occurrence and which date.

To act on the whole series, the agent must pass `occurrence: 'series'`, which by Andy's instructions requires the user to have explicitly said something like "the whole series" or "every Tuesday."

This default makes the cheap-mistake (deleting one occurrence when meant another) recoverable, and the expensive-mistake (deleting the entire series) require explicit user intent.

---

## 5. Timezone handling

The MCP server reads `process.env.TZ` at startup (already injected into containers per `docs/BUILD-NANOCLAW-SIGNAL.md`). Defaults to UTC if unset.

- **Outbound to Graph:** all `dateTime` payloads use ISO 8601 with explicit `timeZone` field (e.g., `{ dateTime: "2026-05-02T15:00:00", timeZone: "Europe/London" }`).
- **Inbound from Graph:** events are returned in the calendar's native timezone; the server converts to the container's TZ for display in tool output.

This means "tomorrow at 3pm" naturally resolves to 3pm in the user's local time, regardless of where Outlook stores the event.

---

## 6. Find-free-time logic

`outlook_find_free_time` is a local computation, not a Graph call to `/me/findMeetingTimes` (which is for cross-attendee scheduling).

```
1. Fetch calendarView for [startRange, endRange]
2. Filter to events where showAs ∈ {busy, oof, tentative} (skip "free" events)
3. Compute gaps between consecutive busy blocks
4. Return gaps where (gap.duration >= minDurationMinutes)
```

Output:

```json
[
  { "start": "2026-05-02T09:00:00+01:00", "end": "2026-05-02T10:30:00+01:00", "durationMinutes": 90 },
  { "start": "2026-05-02T13:00:00+01:00", "end": "2026-05-02T14:00:00+01:00", "durationMinutes": 60 }
]
```

V1 ignores working-hours preferences (gap from midnight to 8am is technically "free"). The agent's system prompt should note "free time" usually means within working hours, but the tool stays dumb for now. Future enhancement: read working hours from `/me/mailboxSettings`.

---

## 7. Tool schema details

### `outlook_list_events`

```typescript
{
  startRange: z.string().describe('ISO 8601 datetime, inclusive. e.g. 2026-05-01T00:00:00'),
  endRange: z.string().describe('ISO 8601 datetime, exclusive'),
  calendarId: z.string().optional().describe('Calendar ID. Omit for default calendar'),
  query: z.string().optional().describe('Filter by keyword in subject or body'),
  top: z.number().int().min(1).max(100).default(50),
}
```

Returns:

```json
[
  {
    "id": "...",
    "subject": "Standup",
    "start": "2026-05-02T09:00:00+01:00",
    "end": "2026-05-02T09:15:00+01:00",
    "location": "Online",
    "isAllDay": false,
    "isOrganizer": true,
    "attendeeCount": 4,
    "isRecurring": true,
    "showAs": "busy",
    "categories": []
  }
]
```

### `outlook_create_event`

```typescript
{
  subject: z.string(),
  start: z.string().describe('ISO 8601 datetime, no timezone — uses container TZ'),
  end: z.string().describe('ISO 8601 datetime, no timezone — uses container TZ'),
  body: z.string().optional(),
  location: z.string().optional(),
  isAllDay: z.boolean().default(false),
  reminderMinutesBeforeStart: z.number().int().min(0).default(15),
  showAs: z.enum(['free', 'tentative', 'busy', 'oof', 'workingElsewhere']).default('busy'),
  // No `attendees` field — enforces personal-only at the schema level
}
```

### `outlook_update_event`

```typescript
{
  eventId: z.string(),
  occurrence: z.enum(['this', 'series']).default('this'),
  // All other fields optional — only patches what's provided
  subject: z.string().optional(),
  start: z.string().optional(),
  end: z.string().optional(),
  body: z.string().optional(),
  location: z.string().optional(),
  showAs: z.enum(['free', 'tentative', 'busy', 'oof', 'workingElsewhere']).optional(),
}
```

Server flow:
1. Fetch event, count attendees
2. If `attendees.length === 0`: PATCH directly, return success
3. Else: issue previewToken, return preview, wait for `outlook_confirm_update(previewToken)`

### `outlook_delete_event`, `outlook_respond_to_invite`

Both use the two-step pattern. Confirmation tools:

- `outlook_confirm_delete({ previewToken })`
- `outlook_confirm_invite_response({ previewToken })`

`outlook_respond_to_invite` first call:

```typescript
{
  eventId: z.string(),
  response: z.enum(['accept', 'tentativelyAccept', 'decline']),
  comment: z.string().optional(),
  sendResponse: z.boolean().default(true),  // Whether to email the organizer
}
```

---

## 8. Error handling

- **Token refresh failure:** existing behavior — surfaces `invalid_grant` clearly so the user knows to re-auth.
- **Permission errors (403):** surface to the agent with a hint that the scope may be missing, suggesting `/add-outlook` re-run.
- **Event not found (404):** return a clean error; the agent can apologize and re-list events.
- **Concurrent modification (412 Precondition Failed):** rare for personal calendars; surface raw and let the agent retry.
- **Approval token expired or invalid:** server returns `{ error: 'token_expired_or_invalid' }`; the agent should re-issue the action.

---

## 9. Testing strategy

`calendar.test.ts` covers:

1. **Schema validation** — `create_event` rejects payloads with `attendees` field
2. **Approval token issuance** — `delete_event` returns a token, payload is round-trippable
3. **Approval token verification** — wrong/expired/forged tokens are rejected
4. **Single-use enforcement** — using a token twice fails the second time
5. **Conditional approval logic** — `update_event` is direct for solo events, gated for events with attendees (mocked Graph response)
6. **Recurring event default** — `delete_event` defaults to `occurrence: 'this'` when omitted
7. **Free-time gap computation** — given a fixture calendarView, returns expected gaps; respects `minDurationMinutes`; handles back-to-back events; handles empty calendar

Graph API calls are mocked. Real-network integration is out of scope for unit tests.

---

## 10. File changes

| File | Action | Notes |
|---|---|---|
| `container/outlook-mcp/index.ts` | Modify | Update OAuth scope. Import and register calendar tools. Wire approval-token store |
| `container/outlook-mcp/calendar.ts` | Create | All calendar tool implementations + free-time logic |
| `container/outlook-mcp/approval-tokens.ts` | Create | `issueToken`, `verifyAndConsumeToken` |
| `container/outlook-mcp/calendar.test.ts` | Create | Unit tests per §9 |
| `skills/add-outlook/SKILL.md` | Modify | Add Calendar scope to OAuth setup steps. Add re-auth flow for existing users |
| `groups/main/CLAUDE.md` | Modify | Add usage guidance: when to use which calendar tool, recurring-event language convention, approval flow expectations |
| `docs/REQUIREMENTS.md` | Modify | Document calendar capabilities and approval boundary |

---

## 11. Out of scope (deferred)

- **Microsoft To-Do / Tasks** — separate scope (`Tasks.ReadWrite`), separate Graph endpoints. Future skill if Greg wants Andy to manage tasks.
- **Working-hours awareness in find-free-time** — V1 returns literal gaps. V2 can read `/me/mailboxSettings`.
- **Cross-attendee scheduling** (`/me/findMeetingTimes`) — requires attendees, which V1 doesn't support.
- **Shared calendars** — `Calendars.ReadWrite.Shared` scope not requested. V1 is personal-only.
- **Categories / colors** — readable from `outlook_get_event` but no dedicated filter tool.
- **Attachments on events** — readable, but no tooling to add/remove.

---

## 12. Success criteria

- Andy can answer "what's on my calendar today/tomorrow/this week" with structured event data
- Andy can create solo events ("block 2-3pm tomorrow for deep work") without prompting for approval
- Andy can find free time gaps for ADHD-friendly day planning
- Andy must show a preview and get explicit user approval before any delete, attendee-event update, or invite RSVP
- Existing email functionality is unaffected by the upgrade
- Re-auth path is documented and works on first attempt for an existing user
