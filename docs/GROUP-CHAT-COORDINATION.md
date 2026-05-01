# Group Chat Bot Coordination Spec

## Problem

Multiple NanoClaw bots in the same Signal group all receive every message simultaneously. Each starts responding immediately, producing overlapping answers. Worse, each bot sees the other's response and tries to acknowledge it, creating recursive "oh, you already answered" loops.

## Goal

Bots in a shared group chat should **cooperate without central coordination** — one responds while others defer, unless they have something genuinely different to add.

## Design: Two-Layer Cooperative Backoff

The approach is **CSMA/CA** (like WiFi): random backoff + carrier sense before transmitting.

No shared state between bots is required. Each bot independently:

1. Delays randomly (statistical collision avoidance)
2. Observes typing indicators (distributed signalling via Signal's own protocol)
3. Sees responses from other bots (post-hoc deduplication)

### Layer 1: Random Backoff Window

When a **group message** arrives from a non-bot sender:

1. Generate a random delay
2. During that window, **accumulate** any additional messages that arrive (humans typing more, or another bot responding)
3. When the timer expires, check: did another bot already respond?
   - **Yes** — pass the full context (original message + bot response) to Claude and let it decide whether it still has something to add
   - **No** — proceed normally

**Critical:** the backoff window must be longer than the typical end-to-end bot response time (backoff + AI generation + send), otherwise both bots' timers expire before either has actually replied. With Layer 1 alone, use a wide range like **5–20 seconds**. The trade-off is slower group responses, but reliable deduplication. Adding Layer 2 (typing indicators) allows much shorter backoffs — see Notes.

Each new human message in the group **resets** the backoff timer, so rapid-fire messages are batched naturally.

### Layer 2: Typing Indicator Awareness

signal-cli emits `typingMessage` events in JSON-RPC envelopes:

```json
{
  "envelope": {
    "typingMessage": {
      "action": "STARTED" | "STOPPED",
      "timestamp": 1636538562919
    }
  }
}
```

Currently `signal.ts` discards these at the early return:

```typescript
if (!dataMsg && !syncMsg) return;  // ← typingMessage silently dropped
```

**Enhancement:** Intercept `typingMessage` events and use them to extend the backoff:

1. Bot receives group message → starts random backoff timer
2. During backoff, a `typingMessage` with `action: "STARTED"` arrives from a **known bot number** → **pause the backoff timer**
3. Wait for one of:
   - An actual message from that sender (they sent their response) → include it in context
   - `action: "STOPPED"` from that sender and no message within 3 seconds (they cancelled)
   - Timeout (90 seconds — they crashed or disconnected)
4. Once resolved, proceed — Claude receives the full context including any bot responses and decides whether to also reply

## Implementation

All changes are confined to `signal.ts` in each bot's NanoClaw channel code.

### New: `GroupBackoffManager` class

```
GroupBackoffManager
├── pendingGroups: Map<groupId, GroupBackoffState>
├── onGroupMessage(groupId, message)       — start or reset backoff timer
├── onTypingIndicator(groupId, sender, action) — pause/resume if bot is typing
├── onBackoffExpired(groupId)              — flush accumulated messages to onMessage
└── config: { minDelayMs, maxDelayMs, typingTimeoutMs, typingStopGraceMs }
```

**`GroupBackoffState`:**
```typescript
interface GroupBackoffState {
  messages: NewMessage[];           // accumulated messages during backoff
  timer: NodeJS.Timeout;            // the backoff timer
  typingBots: Set<string>;          // bot senders currently typing
  backoffMs: number;                // the chosen random delay
  startedAt: number;                // when backoff started
  paused: boolean;                  // true while a known bot is typing
  pausedAt: number | null;          // when we paused (to resume with remaining time)
}
```

### Modified: `handleMessage()`

```typescript
private async handleMessage(params: unknown): Promise<void> {
  const p = params as Record<string, unknown>;
  const envelope = p?.envelope as Record<string, unknown> | undefined;
  if (!envelope) return;

  const source = (envelope.sourceNumber ?? envelope.source ?? '') as string;
  const sourceName = (envelope.sourceName ?? source) as string;
  const timestamp = /* ... existing ... */;

  // --- NEW: intercept typing indicators ---
  const typingMsg = envelope.typingMessage as Record<string, unknown> | undefined;
  if (typingMsg) {
    const action = typingMsg.action as string;    // "STARTED" or "STOPPED"
    const groupInfo = typingMsg.groupId as string | undefined;
    if (groupInfo && this.isKnownBot(source)) {
      this.backoffManager.onTypingIndicator(
        phoneToJid(groupInfo),
        source,
        action,
      );
    }
    return;
  }
  // --- END NEW ---

  const dataMsg = envelope.dataMessage as /* ... existing ... */;
  const syncMsg = envelope.syncMessage as /* ... existing ... */;
  if (!dataMsg && !syncMsg) return;

  // ... existing message parsing ...

  // --- MODIFIED: group messages go through backoff ---
  if (isGroup && !isFromMe) {
    this.backoffManager.onGroupMessage(chatJid, message);
    return;  // will be flushed when backoff expires
  }

  // DMs bypass backoff entirely
  this.opts.onMessage(chatJid, message);
}
```

### New: `isKnownBot()` helper

```typescript
private knownBots: Set<string>;  // populated from env

private isKnownBot(phone: string): boolean {
  return this.knownBots.has(phone);
}
```

### New: Environment variables

```
SIGNAL_KNOWN_BOTS=+447344087212,+447344087213
GROUP_BACKOFF_MIN_MS=5000       # increase to 2000 once Layer 2 is active
GROUP_BACKOFF_MAX_MS=20000      # increase to 6000 once Layer 2 is active
GROUP_TYPING_TIMEOUT_MS=90000
GROUP_TYPING_STOP_GRACE_MS=3000
```

## Backoff Flow Diagram

```
Human sends message in group
         │
         ▼
  ┌─────────────┐
  │ Start random │
  │ backoff timer│  (5–20s L1 only, 2–6s with L2)
  │ accumulate   │
  │ messages     │
  └──────┬───────┘
         │
    ┌────┴────────────────────────┐
    │  During backoff window...   │
    │                             │
    │  Bot typing indicator? ─────┼──► Pause timer, wait for
    │                             │    their message or timeout
    │  Another human message? ────┼──► Reset timer, accumulate
    │                             │
    │  Another bot's response? ───┼──► Accumulate (bot responded
    │                             │    before we did)
    └────┬────────────────────────┘
         │
         ▼  Timer expires
  ┌─────────────────┐
  │ Did another bot  │
  │ already respond? │
  └──┬──────────┬────┘
     │          │
    Yes         No
     │          │
     ▼          ▼
  ┌────────┐  ┌────────────┐
  │ Pass   │  │ Proceed    │
  │ full   │  │ normally   │
  │ context│  │            │
  │ to AI  │  └────────────┘
  │        │
  │ Let it │
  │ decide │
  │ whether│
  │ to add │
  └────────┘
```

## Edge Cases

| Scenario | Behaviour |
|----------|-----------|
| Human sends 3 messages rapidly | Backoff timer resets each time; all 3 accumulate and are delivered together |
| Both bots' timers expire simultaneously | Both respond — acceptable rare case, minimised by wide random range |
| Other bot starts typing then crashes | 90s timeout, then proceed |
| Other bot responds with wrong/incomplete answer | Claude sees the response in context, can add corrections |
| Human @-mentions a specific bot by name | **Skip backoff entirely** — respond immediately |
| DM (not group chat) | No backoff — immediate processing |
| Message from a known bot | Do **not** reset backoff timer — only human messages reset it |
| Bot's own messages (sync/echo) | Filtered as before (is_from_me / is_bot_message flags) |

## Direct Mention Bypass

If the message text contains the bot's own name (e.g. `@Cal` or `Cal,`), skip backoff and respond immediately. This lets humans direct a question to a specific bot and get an instant answer.

```typescript
private isDirectMention(text: string): boolean {
  const name = ASSISTANT_NAME.toLowerCase();
  const lower = text.toLowerCase();
  return lower.includes(`@${name}`) || lower.startsWith(`${name},`) || lower.startsWith(`${name} `);
}
```

## CLAUDE-group.md Update

Add to each bot's group chat system prompt:

```markdown
## Multi-Bot Awareness

You are in a group chat that may contain other AI bots. When you see a response from another bot:

- Do NOT say "oh, you already answered" or similar meta-commentary
- If the other bot's answer is complete and correct, say nothing (output empty or a brief acknowledgement only if directly asked)
- If you have something genuinely different or additional to contribute, add it concisely
- Never ask another bot "what do you think?" — they will respond on their own if relevant
- Never narrate the coordination ("I see Cal already responded...") — just respond to the human's question or stay silent
```

## Testing

1. **Basic backoff**: Send a message in the group → verify a 5–20 second delay before response (Layer 1 defaults)
2. **Accumulation**: Send 3 messages rapidly → verify all 3 are delivered as a batch
3. **Collision avoidance**: Have two bots in the group → verify only one typically responds to a simple question
4. **Typing indicator**: Check logs for `typingMessage` events being intercepted (may need signal-cli version verification)
5. **Direct mention**: Send `@Cal what time is it?` → verify immediate response (no backoff)
6. **DM unaffected**: Send a DM → verify no delay
7. **Timeout**: Block the other bot mid-typing → verify 90s timeout then response

## Notes

- The `typingMessage` envelope field has had inconsistent support across signal-cli versions. If it doesn't appear in JSON-RPC events, Layer 1 (random backoff) still provides effective coordination on its own. Layer 2 is a refinement, not a requirement.
- **Backoff values depend on which layers are active:**
  - **Layer 1 only:** The backoff window must be **longer than the typical bot response time** (backoff + AI generation + send). If a bot typically takes 10 seconds end-to-end, a 2–6s backoff means both bots' timers expire before either has actually replied, and both still respond. In this case, use a wider range like 5–20s — the "losing" bot needs to wait long enough to *see the winner's response arrive* before its own timer expires. The trade-off is slower responses to the human, since every group message incurs the full backoff delay even when only one bot is present.
  - **Layer 1 + Layer 2:** The backoff can be much shorter (2–6s) because it only needs to create enough separation for one bot to *start typing first*. Once the winning bot's typing indicator is visible, the other bot pauses and waits for the actual response. This gives faster responses with better coordination.
- This outlines the considerable benefit in implementing Layer 2 if the signal-cli version supports the typing message functionality - it avoids causing very slow initial responses due to the need for a long backoff period.
- This spec is channel-agnostic in principle but the typing indicator integration is Signal-specific. Telegram has similar typing status APIs if needed later.
