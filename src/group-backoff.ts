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
  typingBots: Map<string, ReturnType<typeof setTimeout>>;
  backoffMs: number;
  startedAt: number;
  paused: boolean;
  pausedAt: number | null;
  remainingMs: number;
}

export type OnBackoffFlush = (groupJid: string, messages: NewMessage[]) => void;

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
        existing.timer = setTimeout(() => this.flush(groupJid), backoffMs);
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

  onTypingIndicator(groupJid: string, sender: string, action: string): void {
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

    state.timer = setTimeout(() => this.flush(groupJid), state.remainingMs);

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
