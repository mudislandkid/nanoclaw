# Group Chat Coordination Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement cooperative backoff so multiple NanoClaw bots in the same Signal group don't all respond to every message simultaneously.

**Architecture:** A `GroupBackoffManager` class in its own file handles random backoff (Layer 1) and typing indicator awareness (Layer 2). Signal channel intercepts typing events and routes group messages through the backoff manager instead of delivering them immediately. DMs and direct @-mentions bypass backoff entirely.

**Tech Stack:** TypeScript, Node.js timers, vitest for testing

---

## File Structure

| File | Action | Responsibility |
|------|--------|---------------|
| `src/group-backoff.ts` | Create | `GroupBackoffManager` class — random backoff timers, typing indicator pausing, message accumulation, flush callback |
| `src/group-backoff.test.ts` | Create | Unit tests for backoff manager |
| `src/channels/signal.ts` | Modify | Intercept typing indicators, route group messages through backoff, direct mention bypass, known bot config |

---

### Task 1: GroupBackoffManager — Core Backoff Logic (Layer 1)

**Files:**
- Create: `src/group-backoff.ts`
- Create: `src/group-backoff.test.ts`

- [ ] **Step 1: Write failing tests for basic backoff behavior**

```typescript
// src/group-backoff.test.ts
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { GroupBackoffManager, GroupBackoffConfig } from './group-backoff.js';
import type { NewMessage } from './types.js';

function makeMessage(overrides: Partial<NewMessage> = {}): NewMessage {
  return {
    id: `msg-${Date.now()}-${Math.random()}`,
    chat_jid: 'signal:group1',
    sender: 'signal:+447000000001',
    sender_name: 'Human',
    content: 'hello',
    timestamp: new Date().toISOString(),
    is_from_me: false,
    is_bot_message: false,
    ...overrides,
  };
}

const TEST_CONFIG: GroupBackoffConfig = {
  minDelayMs: 100,
  maxDelayMs: 200,
  typingTimeoutMs: 500,
  typingStopGraceMs: 50,
};

describe('GroupBackoffManager', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('delays group messages by a random backoff before flushing', async () => {
    const onFlush = vi.fn();
    const mgr = new GroupBackoffManager(TEST_CONFIG, onFlush);

    const msg = makeMessage({ chat_jid: 'signal:group1' });
    mgr.onGroupMessage('signal:group1', msg);

    // Not flushed immediately
    expect(onFlush).not.toHaveBeenCalled();

    // Flush after max delay
    await vi.advanceTimersByTimeAsync(TEST_CONFIG.maxDelayMs + 10);
    expect(onFlush).toHaveBeenCalledTimes(1);
    expect(onFlush).toHaveBeenCalledWith('signal:group1', [msg]);
  });

  it('accumulates multiple messages during backoff window', async () => {
    const onFlush = vi.fn();
    const mgr = new GroupBackoffManager(TEST_CONFIG, onFlush);

    const msg1 = makeMessage({ content: 'first' });
    const msg2 = makeMessage({ content: 'second' });
    const msg3 = makeMessage({ content: 'third' });

    mgr.onGroupMessage('signal:group1', msg1);
    await vi.advanceTimersByTimeAsync(50);
    mgr.onGroupMessage('signal:group1', msg2);
    await vi.advanceTimersByTimeAsync(50);
    mgr.onGroupMessage('signal:group1', msg3);

    // Timer was reset by each new message, so nothing flushed yet
    expect(onFlush).not.toHaveBeenCalled();

    // Wait for full backoff after last message
    await vi.advanceTimersByTimeAsync(TEST_CONFIG.maxDelayMs + 10);
    expect(onFlush).toHaveBeenCalledTimes(1);
    expect(onFlush).toHaveBeenCalledWith('signal:group1', [msg1, msg2, msg3]);
  });

  it('resets timer on new human messages but not bot messages', async () => {
    const onFlush = vi.fn();
    const mgr = new GroupBackoffManager(TEST_CONFIG, onFlush);

    const humanMsg = makeMessage({ content: 'hello' });
    mgr.onGroupMessage('signal:group1', humanMsg);

    await vi.advanceTimersByTimeAsync(80);

    // Bot message arrives — should accumulate but NOT reset timer
    const botMsg = makeMessage({ content: 'bot reply', is_bot_message: true });
    mgr.onGroupMessage('signal:group1', botMsg);

    // Original timer should still fire at its original schedule
    // (within maxDelayMs of the first human message)
    await vi.advanceTimersByTimeAsync(TEST_CONFIG.maxDelayMs);
    expect(onFlush).toHaveBeenCalledTimes(1);
    expect(onFlush).toHaveBeenCalledWith('signal:group1', [humanMsg, botMsg]);
  });

  it('handles multiple groups independently', async () => {
    const onFlush = vi.fn();
    const mgr = new GroupBackoffManager(TEST_CONFIG, onFlush);

    const msg1 = makeMessage({ chat_jid: 'signal:group1' });
    const msg2 = makeMessage({ chat_jid: 'signal:group2' });

    mgr.onGroupMessage('signal:group1', msg1);
    mgr.onGroupMessage('signal:group2', msg2);

    await vi.advanceTimersByTimeAsync(TEST_CONFIG.maxDelayMs + 10);

    expect(onFlush).toHaveBeenCalledTimes(2);
  });

  it('cleans up state after flushing', async () => {
    const onFlush = vi.fn();
    const mgr = new GroupBackoffManager(TEST_CONFIG, onFlush);

    mgr.onGroupMessage('signal:group1', makeMessage());
    await vi.advanceTimersByTimeAsync(TEST_CONFIG.maxDelayMs + 10);
    expect(onFlush).toHaveBeenCalledTimes(1);

    // Second message starts fresh
    mgr.onGroupMessage('signal:group1', makeMessage({ content: 'new' }));
    await vi.advanceTimersByTimeAsync(TEST_CONFIG.maxDelayMs + 10);
    expect(onFlush).toHaveBeenCalledTimes(2);
    expect(onFlush.mock.calls[1][1]).toHaveLength(1);
  });

  it('shutdown clears all pending timers and flushes remaining', async () => {
    const onFlush = vi.fn();
    const mgr = new GroupBackoffManager(TEST_CONFIG, onFlush);

    mgr.onGroupMessage('signal:group1', makeMessage());
    mgr.onGroupMessage('signal:group2', makeMessage());

    mgr.shutdown();

    // Both groups should have flushed immediately
    expect(onFlush).toHaveBeenCalledTimes(2);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/group-backoff.test.ts`
Expected: FAIL — module `./group-backoff.js` does not exist

- [ ] **Step 3: Implement GroupBackoffManager**

```typescript
// src/group-backoff.ts
import { logger } from './logger.js';
import type { NewMessage } from './types.js';

export interface GroupBackoffConfig {
  minDelayMs: number;
  maxDelayMs: number;
  typingTimeoutMs: number;
  typingStopGraceMs: number;
}

interface GroupBackoffState {
  messages: NewMessage[];
  timer: ReturnType<typeof setTimeout>;
  typingBots: Map<string, ReturnType<typeof setTimeout>>; // sender -> timeout handle
  backoffMs: number;
  startedAt: number;
  paused: boolean;
  pausedAt: number | null;
  remainingMs: number; // time left when paused
}

export type OnBackoffFlush = (
  groupJid: string,
  messages: NewMessage[],
) => void;

export class GroupBackoffManager {
  private pending = new Map<string, GroupBackoffState>();
  private config: GroupBackoffConfig;
  private onFlush: OnBackoffFlush;

  constructor(config: GroupBackoffConfig, onFlush: OnBackoffFlush) {
    this.config = config;
    this.onFlush = onFlush;
  }

  onGroupMessage(groupJid: string, message: NewMessage): void {
    const existing = this.pending.get(groupJid);

    if (existing) {
      existing.messages.push(message);

      // Only reset the timer for human (non-bot) messages
      if (!message.is_bot_message) {
        clearTimeout(existing.timer);
        const backoffMs = this.randomBackoff();
        existing.backoffMs = backoffMs;
        existing.startedAt = Date.now();
        existing.paused = false;
        existing.pausedAt = null;
        existing.remainingMs = backoffMs;
        existing.timer = setTimeout(
          () => this.flush(groupJid),
          backoffMs,
        );
      }
      return;
    }

    // New group backoff
    const backoffMs = this.randomBackoff();
    const state: GroupBackoffState = {
      messages: [message],
      timer: setTimeout(() => this.flush(groupJid), backoffMs),
      typingBots: new Map(),
      backoffMs,
      startedAt: Date.now(),
      paused: false,
      pausedAt: null,
      remainingMs: backoffMs,
    };
    this.pending.set(groupJid, state);

    logger.debug(
      { groupJid, backoffMs },
      'GroupBackoff: started backoff for group',
    );
  }

  onTypingIndicator(
    groupJid: string,
    sender: string,
    action: string,
  ): void {
    const state = this.pending.get(groupJid);
    if (!state) return;

    if (action === 'STARTED') {
      // Pause our backoff timer — a known bot is typing
      if (!state.paused) {
        clearTimeout(state.timer);
        const elapsed = Date.now() - state.startedAt;
        state.remainingMs = Math.max(0, state.backoffMs - elapsed);
        state.paused = true;
        state.pausedAt = Date.now();
        logger.debug(
          { groupJid, sender, remainingMs: state.remainingMs },
          'GroupBackoff: paused — bot is typing',
        );
      }

      // Set a safety timeout for this typing bot
      const existingTimeout = state.typingBots.get(sender);
      if (existingTimeout) clearTimeout(existingTimeout);

      const timeout = setTimeout(() => {
        state.typingBots.delete(sender);
        logger.debug(
          { groupJid, sender },
          'GroupBackoff: typing timeout — bot may have crashed',
        );
        this.maybeResume(groupJid);
      }, this.config.typingTimeoutMs);

      state.typingBots.set(sender, timeout);
    } else if (action === 'STOPPED') {
      // Bot stopped typing without sending — wait grace period then resume
      const existingTimeout = state.typingBots.get(sender);
      if (existingTimeout) clearTimeout(existingTimeout);

      const graceTimeout = setTimeout(() => {
        state.typingBots.delete(sender);
        logger.debug(
          { groupJid, sender },
          'GroupBackoff: typing stopped — grace period expired',
        );
        this.maybeResume(groupJid);
      }, this.config.typingStopGraceMs);

      state.typingBots.set(sender, graceTimeout);
    }
  }

  shutdown(): void {
    for (const [groupJid] of this.pending) {
      this.flush(groupJid);
    }
  }

  private maybeResume(groupJid: string): void {
    const state = this.pending.get(groupJid);
    if (!state || !state.paused) return;

    // Only resume if no bots are still typing
    if (state.typingBots.size > 0) return;

    state.paused = false;
    state.pausedAt = null;
    state.startedAt = Date.now();
    state.backoffMs = state.remainingMs;

    state.timer = setTimeout(
      () => this.flush(groupJid),
      state.remainingMs,
    );

    logger.debug(
      { groupJid, remainingMs: state.remainingMs },
      'GroupBackoff: resumed timer',
    );
  }

  private flush(groupJid: string): void {
    const state = this.pending.get(groupJid);
    if (!state) return;

    // Clean up typing bot timeouts
    for (const timeout of state.typingBots.values()) {
      clearTimeout(timeout);
    }

    this.pending.delete(groupJid);

    logger.debug(
      { groupJid, messageCount: state.messages.length },
      'GroupBackoff: flushing messages',
    );

    this.onFlush(groupJid, state.messages);
  }

  private randomBackoff(): number {
    const { minDelayMs, maxDelayMs } = this.config;
    return minDelayMs + Math.random() * (maxDelayMs - minDelayMs);
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/group-backoff.test.ts`
Expected: All 6 tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/group-backoff.ts src/group-backoff.test.ts
git commit -m "feat: add GroupBackoffManager with Layer 1 random backoff"
```

---

### Task 2: GroupBackoffManager — Typing Indicator Tests (Layer 2)

**Files:**
- Modify: `src/group-backoff.test.ts`

- [ ] **Step 1: Add typing indicator tests**

Append to the existing `describe('GroupBackoffManager')` block in `src/group-backoff.test.ts`:

```typescript
  it('pauses backoff when a known bot starts typing', async () => {
    const onFlush = vi.fn();
    const mgr = new GroupBackoffManager(TEST_CONFIG, onFlush);

    mgr.onGroupMessage('signal:group1', makeMessage());

    // Bot starts typing after 50ms
    await vi.advanceTimersByTimeAsync(50);
    mgr.onTypingIndicator('signal:group1', '+447000000099', 'STARTED');

    // Wait well past the normal backoff window — should NOT flush (paused)
    await vi.advanceTimersByTimeAsync(TEST_CONFIG.maxDelayMs + 100);
    expect(onFlush).not.toHaveBeenCalled();

    // Bot sends a message (stops tracking) — simulate by stopping + grace
    mgr.onTypingIndicator('signal:group1', '+447000000099', 'STOPPED');
    await vi.advanceTimersByTimeAsync(TEST_CONFIG.typingStopGraceMs + 10);

    // Now remaining backoff resumes and eventually flushes
    await vi.advanceTimersByTimeAsync(TEST_CONFIG.maxDelayMs);
    expect(onFlush).toHaveBeenCalledTimes(1);
  });

  it('resumes after typing timeout if bot crashes', async () => {
    const onFlush = vi.fn();
    const mgr = new GroupBackoffManager(TEST_CONFIG, onFlush);

    mgr.onGroupMessage('signal:group1', makeMessage());

    await vi.advanceTimersByTimeAsync(50);
    mgr.onTypingIndicator('signal:group1', '+447000000099', 'STARTED');

    // Bot never sends STOPPED or a message — timeout should kick in
    await vi.advanceTimersByTimeAsync(TEST_CONFIG.typingTimeoutMs + TEST_CONFIG.maxDelayMs + 10);
    expect(onFlush).toHaveBeenCalledTimes(1);
  });

  it('accumulates bot response during typing pause', async () => {
    const onFlush = vi.fn();
    const mgr = new GroupBackoffManager(TEST_CONFIG, onFlush);

    const humanMsg = makeMessage({ content: 'question?' });
    mgr.onGroupMessage('signal:group1', humanMsg);

    await vi.advanceTimersByTimeAsync(50);
    mgr.onTypingIndicator('signal:group1', '+447000000099', 'STARTED');

    // Bot's actual response arrives as a message
    const botMsg = makeMessage({ content: 'bot answer', is_bot_message: true });
    mgr.onGroupMessage('signal:group1', botMsg);

    // Bot stops typing
    mgr.onTypingIndicator('signal:group1', '+447000000099', 'STOPPED');
    await vi.advanceTimersByTimeAsync(TEST_CONFIG.typingStopGraceMs + 10);

    // After remaining backoff
    await vi.advanceTimersByTimeAsync(TEST_CONFIG.maxDelayMs);
    expect(onFlush).toHaveBeenCalledTimes(1);
    expect(onFlush.mock.calls[0][1]).toEqual([humanMsg, botMsg]);
  });

  it('ignores typing indicators for groups not in backoff', () => {
    const onFlush = vi.fn();
    const mgr = new GroupBackoffManager(TEST_CONFIG, onFlush);

    // Should not throw
    mgr.onTypingIndicator('signal:unknown-group', '+447000000099', 'STARTED');
    expect(onFlush).not.toHaveBeenCalled();
  });
```

- [ ] **Step 2: Run tests to verify they pass**

Run: `npx vitest run src/group-backoff.test.ts`
Expected: All 10 tests PASS (the implementation from Task 1 already handles Layer 2)

- [ ] **Step 3: Commit**

```bash
git add src/group-backoff.test.ts
git commit -m "test: add typing indicator (Layer 2) tests for GroupBackoffManager"
```

---

### Task 3: Wire GroupBackoffManager into Signal Channel

**Files:**
- Modify: `src/channels/signal.ts`

- [ ] **Step 1: Add imports, config loading, and known bots setup**

At the top of `src/channels/signal.ts`, add the import after the existing imports:

```typescript
import {
  GroupBackoffConfig,
  GroupBackoffManager,
} from '../group-backoff.js';
```

Add a config loader function after the `getSignalEnv()` function:

```typescript
function getBackoffConfig(): GroupBackoffConfig {
  const env = readEnvFile([
    'GROUP_BACKOFF_MIN_MS',
    'GROUP_BACKOFF_MAX_MS',
    'GROUP_TYPING_TIMEOUT_MS',
    'GROUP_TYPING_STOP_GRACE_MS',
  ]);
  return {
    minDelayMs: parseInt(
      process.env.GROUP_BACKOFF_MIN_MS || env.GROUP_BACKOFF_MIN_MS || '5000',
      10,
    ),
    maxDelayMs: parseInt(
      process.env.GROUP_BACKOFF_MAX_MS || env.GROUP_BACKOFF_MAX_MS || '20000',
      10,
    ),
    typingTimeoutMs: parseInt(
      process.env.GROUP_TYPING_TIMEOUT_MS || env.GROUP_TYPING_TIMEOUT_MS || '90000',
      10,
    ),
    typingStopGraceMs: parseInt(
      process.env.GROUP_TYPING_STOP_GRACE_MS || env.GROUP_TYPING_STOP_GRACE_MS || '3000',
      10,
    ),
  };
}

function getKnownBots(): Set<string> {
  const env = readEnvFile(['SIGNAL_KNOWN_BOTS']);
  const raw = process.env.SIGNAL_KNOWN_BOTS || env.SIGNAL_KNOWN_BOTS || '';
  if (!raw) return new Set();
  return new Set(raw.split(',').map((s) => s.trim()).filter(Boolean));
}
```

- [ ] **Step 2: Add backoff manager and known bots to SignalChannel class**

Add new private fields to the `SignalChannel` class (after `private opts: ChannelOpts;`):

```typescript
  private knownBots: Set<string>;
  private backoffManager: GroupBackoffManager;
```

Update the constructor to initialise them:

```typescript
  constructor(opts: ChannelOpts) {
    this.opts = opts;
    const env = getSignalEnv();
    this.botPhone = env.botPhone;
    this.userPhone = env.userPhone;
    this.knownBots = getKnownBots();
    this.backoffManager = new GroupBackoffManager(
      getBackoffConfig(),
      (groupJid, messages) => {
        for (const msg of messages) {
          this.opts.onMessage(groupJid, msg);
        }
      },
    );
  }
```

- [ ] **Step 3: Add direct mention detection helper**

Add after the `isGroupId()` method:

```typescript
  private isDirectMention(text: string): boolean {
    const name = ASSISTANT_NAME.toLowerCase();
    const lower = text.toLowerCase();
    return (
      lower.includes(`@${name}`) ||
      lower.startsWith(`${name},`) ||
      lower.startsWith(`${name} `)
    );
  }

  private isKnownBot(phone: string): boolean {
    return this.knownBots.has(phone);
  }
```

- [ ] **Step 4: Intercept typing indicators in handleMessage**

In `handleMessage()`, add typing indicator interception **before** the existing `if (!dataMsg && !syncMsg) return;` line (line 291). Replace the early return with:

```typescript
    // Intercept typing indicators for group backoff coordination
    const typingMsg = envelope.typingMessage as
      | Record<string, unknown>
      | undefined;
    if (typingMsg) {
      const action = typingMsg.action as string; // "STARTED" or "STOPPED"
      const groupId = typingMsg.groupId as string | undefined;
      if (groupId && this.isKnownBot(source)) {
        this.backoffManager.onTypingIndicator(
          phoneToJid(groupId),
          source,
          action,
        );
      }
      return;
    }

    const dataMsg = envelope.dataMessage as Record<string, unknown> | undefined;
    const syncMsg = envelope.syncMessage as Record<string, unknown> | undefined;

    // Only process data messages and sync messages (Note to Self outbound)
    if (!dataMsg && !syncMsg) return;
```

This replaces the existing lines 287-291:
```typescript
    const dataMsg = envelope.dataMessage as Record<string, unknown> | undefined;
    const syncMsg = envelope.syncMessage as Record<string, unknown> | undefined;

    // Only process data messages and sync messages (Note to Self outbound)
    if (!dataMsg && !syncMsg) return;
```

- [ ] **Step 5: Route group messages through backoff (with direct mention bypass)**

At the end of `handleMessage()`, replace the final `this.opts.onMessage(chatJid, message);` call (line 477) with:

```typescript
    // Group messages from others go through backoff (unless direct mention)
    const isGroup = this.isGroupId(jidToPhone(chatJid));
    if (isGroup && !isFromMe && !this.isDirectMention(finalContent)) {
      this.backoffManager.onGroupMessage(chatJid, message);
      return;
    }

    this.opts.onMessage(chatJid, message);
```

Note: There's an existing `isGroup` variable computed earlier at line 365 for metadata purposes. Reuse that or rename — the simplest approach is to just reuse the existing `isGroup` const that's already in scope and skip the re-declaration:

```typescript
    // Group messages from others go through backoff (unless direct mention)
    if (isGroup && !isFromMe && !this.isDirectMention(finalContent)) {
      this.backoffManager.onGroupMessage(chatJid, message);
      return;
    }

    this.opts.onMessage(chatJid, message);
```

- [ ] **Step 6: Add shutdown call to disconnect**

In the `disconnect()` method, add backoff shutdown before the existing disconnect:

```typescript
  async disconnect(): Promise<void> {
    this.backoffManager.shutdown();
    this.connected = false;
    await this.signal.gracefulShutdown();
    logger.info('Signal: disconnected');
  }
```

- [ ] **Step 7: Build to verify no type errors**

Run: `npm run build`
Expected: Clean compilation with no errors

- [ ] **Step 8: Run all tests**

Run: `npx vitest run`
Expected: All tests pass (both existing and new)

- [ ] **Step 9: Commit**

```bash
git add src/channels/signal.ts
git commit -m "feat: wire GroupBackoffManager into Signal channel for multi-bot coordination"
```

---

### Task 4: Update Group CLAUDE.md with Multi-Bot Awareness

**Files:**
- Modify: `groups/signal_main/CLAUDE.md` (or whichever group is the botsplosion group — may need to check)

- [ ] **Step 1: Identify the botsplosion group folder**

Run: `ls groups/` and check which folder corresponds to the botsplosion group. It may have been auto-registered. If it doesn't exist yet, this step can be deferred until the group is registered.

- [ ] **Step 2: Add multi-bot awareness to the group's CLAUDE.md**

Append this section to the relevant group's `CLAUDE.md`:

```markdown
## Multi-Bot Awareness

You are in a group chat that may contain other AI bots. When you see a response from another bot:

- Do NOT say "oh, you already answered" or similar meta-commentary
- If the other bot's answer is complete and correct, say nothing (output empty or a brief acknowledgement only if directly asked)
- If you have something genuinely different or additional to contribute, add it concisely
- Never ask another bot "what do you think?" — they will respond on their own if relevant
- Never narrate the coordination ("I see Cal already responded...") — just respond to the human's question or stay silent
```

- [ ] **Step 3: Commit**

```bash
git add groups/*/CLAUDE.md
git commit -m "docs: add multi-bot awareness instructions for group chat coordination"
```

---

### Task 5: Add Environment Variable Documentation

**Files:**
- Modify: `docs/GROUP-CHAT-COORDINATION.md` (already exists — no changes needed, it documents the env vars)
- Optionally add vars to `.env.example` if one exists

- [ ] **Step 1: Check if .env.example exists**

Run: `ls .env.example 2>/dev/null`

- [ ] **Step 2: If .env.example exists, add the new variables**

Append:

```
# Group chat coordination (multi-bot backoff)
# SIGNAL_KNOWN_BOTS=+447344087212,+447344087213
# GROUP_BACKOFF_MIN_MS=5000
# GROUP_BACKOFF_MAX_MS=20000
# GROUP_TYPING_TIMEOUT_MS=90000
# GROUP_TYPING_STOP_GRACE_MS=3000
```

- [ ] **Step 3: Commit (if changes were made)**

```bash
git add .env.example
git commit -m "docs: add group backoff env vars to .env.example"
```

---

### Task 6: Integration Smoke Test

- [ ] **Step 1: Run full test suite**

Run: `npx vitest run`
Expected: All tests pass

- [ ] **Step 2: Run build**

Run: `npm run build`
Expected: Clean compilation

- [ ] **Step 3: Manual verification checklist**

Verify these by reading the code:
- [ ] DMs still go straight to `onMessage` (no backoff)
- [ ] `@Andy` in a group message bypasses backoff
- [ ] Bot messages accumulate but don't reset the timer
- [ ] Typing indicators from unknown senders are ignored
- [ ] `shutdown()` flushes all pending groups
