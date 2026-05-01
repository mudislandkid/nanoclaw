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

  // --- Layer 1: Random Backoff ---

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

  // --- Layer 2: Typing Indicator Awareness ---

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
    await vi.advanceTimersByTimeAsync(
      TEST_CONFIG.typingTimeoutMs + TEST_CONFIG.maxDelayMs + 10,
    );
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
});
