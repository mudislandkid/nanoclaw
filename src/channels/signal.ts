import fs from 'fs';
import path from 'path';

import { SignalCli } from 'signal-sdk';

import os from 'os';

import { ASSISTANT_NAME } from '../config.js';
import { readEnvFile } from '../env.js';
import { resolveGroupFolderPath } from '../group-folder.js';
import { processImage } from '../image.js';
import { logger } from '../logger.js';
import { transcribeAudioFile } from '../transcription.js';
import { Channel, NewMessage } from '../types.js';
import { ChannelOpts, registerChannel } from './registry.js';
import { GroupBackoffConfig, GroupBackoffManager } from '../group-backoff.js';

const SIGNAL_PREFIX = 'signal:';

// ---------------------------------------------------------------------------
// Markdown → Signal body ranges
// ---------------------------------------------------------------------------

interface TextStyle {
  start: number;
  length: number;
  style: 'BOLD' | 'ITALIC' | 'STRIKETHROUGH' | 'MONOSPACE' | 'SPOILER';
}

/**
 * Parse markdown formatting from text and return plain text + Signal text styles.
 * Supports: **bold**, *italic*, ~~strikethrough~~, `monospace`, ```code blocks```
 */
function parseMarkdownToSignal(input: string): {
  text: string;
  textStyles: TextStyle[];
} {
  const styles: TextStyle[] = [];
  let text = input;

  // Process fenced code blocks first: ```...```
  text = processPattern(
    text,
    styles,
    /```(?:\w*\n)?([\s\S]*?)```/g,
    'MONOSPACE',
  );
  // Inline code: `...`
  text = processPattern(text, styles, /`([^`]+)`/g, 'MONOSPACE');
  // Bold: **...**
  text = processPattern(text, styles, /\*\*(.+?)\*\*/g, 'BOLD');
  // Italic: *...*
  text = processPattern(text, styles, /(?<!\*)\*([^*]+)\*(?!\*)/g, 'ITALIC');
  // Strikethrough: ~~...~~
  text = processPattern(text, styles, /~~(.+?)~~/g, 'STRIKETHROUGH');

  return { text, textStyles: styles };
}

function processPattern(
  text: string,
  styles: TextStyle[],
  pattern: RegExp,
  style: TextStyle['style'],
): string {
  let result = '';
  let lastIndex = 0;

  for (const match of text.matchAll(pattern)) {
    const fullMatch = match[0];
    const inner = match[1];
    const matchStart = match.index!;

    // Append text before this match
    result += text.slice(lastIndex, matchStart);

    // Record style at the position in the output string
    const styleStart = result.length;
    result += inner;
    styles.push({ start: styleStart, length: inner.length, style });

    lastIndex = matchStart + fullMatch.length;
  }

  // Append remaining text
  result += text.slice(lastIndex);

  return result;
}

function getSignalEnv(): { botPhone: string; userPhone: string } {
  const env = readEnvFile([
    'SIGNAL_BOT_PHONE',
    'SIGNAL_USER_PHONE',
    'SIGNAL_PHONE_NUMBER',
  ]);
  return {
    botPhone:
      process.env.SIGNAL_BOT_PHONE ||
      env.SIGNAL_BOT_PHONE ||
      // Legacy fallback
      process.env.SIGNAL_PHONE_NUMBER ||
      env.SIGNAL_PHONE_NUMBER ||
      '',
    userPhone: process.env.SIGNAL_USER_PHONE || env.SIGNAL_USER_PHONE || '',
  };
}

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
      process.env.GROUP_TYPING_TIMEOUT_MS ||
        env.GROUP_TYPING_TIMEOUT_MS ||
        '90000',
      10,
    ),
    typingStopGraceMs: parseInt(
      process.env.GROUP_TYPING_STOP_GRACE_MS ||
        env.GROUP_TYPING_STOP_GRACE_MS ||
        '3000',
      10,
    ),
  };
}

function getKnownBots(): Set<string> {
  const env = readEnvFile(['SIGNAL_KNOWN_BOTS']);
  const raw = process.env.SIGNAL_KNOWN_BOTS || env.SIGNAL_KNOWN_BOTS || '';
  if (!raw) return new Set();
  return new Set(
    raw
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  );
}

function getKnownBotNames(): Set<string> {
  const env = readEnvFile(['SIGNAL_KNOWN_BOT_NAMES']);
  const raw =
    process.env.SIGNAL_KNOWN_BOT_NAMES || env.SIGNAL_KNOWN_BOT_NAMES || '';
  if (!raw) return new Set();
  return new Set(
    raw
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  );
}

/**
 * Strips the `signal:` prefix from a JID to get the raw phone number.
 * If the prefix is absent, returns the string unchanged (safety fallback).
 */
function jidToPhone(jid: string): string {
  return jid.startsWith(SIGNAL_PREFIX) ? jid.slice(SIGNAL_PREFIX.length) : jid;
}

/**
 * Converts a raw phone number to the nanoclaw JID format used for Signal.
 */
function phoneToJid(phone: string): string {
  return `${SIGNAL_PREFIX}${phone}`;
}

export class SignalChannel implements Channel {
  name = 'signal';

  private signal!: InstanceType<typeof SignalCli>;
  /** Bot's own phone number (signal-cli account) — SIGNAL_BOT_PHONE */
  private botPhone: string;
  /** User's phone number — DM replies go here in primary device mode — SIGNAL_USER_PHONE */
  private userPhone: string;
  private connected = false;
  private outgoingQueue: Array<{ phone: string; text: string }> = [];
  private flushing = false;
  private opts: ChannelOpts;
  private knownBots: Set<string>;
  private knownBotNames: Set<string>;
  private backoffManager: GroupBackoffManager;

  constructor(opts: ChannelOpts) {
    this.opts = opts;
    const env = getSignalEnv();
    this.botPhone = env.botPhone;
    this.userPhone = env.userPhone;
    this.knownBots = getKnownBots();
    this.knownBotNames = getKnownBotNames();
    this.backoffManager = new GroupBackoffManager(
      getBackoffConfig(),
      (groupJid, messages) => {
        for (const msg of messages) {
          this.opts.onMessage(groupJid, msg);
        }
      },
    );
  }

  async connect(): Promise<void> {
    this.signal = new SignalCli(this.botPhone);

    this.signal.on('message', (params: unknown) => {
      logger.debug(
        { params: JSON.stringify(params).slice(0, 200) },
        'Signal: raw event received',
      );
      this.handleMessage(params).catch((err) =>
        logger.error({ err }, 'Signal: unhandled error in message handler'),
      );
    });

    this.signal.on('error', (err: Error) => {
      logger.error({ err: err.message }, 'Signal: SDK error');
    });

    await this.signal.connect();
    this.connected = true;
    logger.info(
      { botPhone: this.botPhone, userPhone: this.userPhone || '(none)' },
      'Signal: connected',
    );

    // Flush any messages queued while disconnected
    this.flushOutgoingQueue().catch((err) =>
      logger.error({ err }, 'Signal: failed to flush outgoing queue'),
    );
  }

  isConnected(): boolean {
    return this.connected;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith(SIGNAL_PREFIX);
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    const rawId = jidToPhone(jid);
    // For group JIDs, pass the group ID directly to the SDK (it auto-detects).
    // For DMs, route to the owner's phone in primary device mode.
    const isGroup = this.isGroupId(rawId);
    const recipient = isGroup
      ? rawId
      : rawId === this.botPhone && this.userPhone
        ? this.userPhone
        : rawId;
    if (!this.connected) {
      this.outgoingQueue.push({ phone: recipient, text });
      logger.info(
        { jid, queueSize: this.outgoingQueue.length },
        'Signal: disconnected, message queued',
      );
      return;
    }

    try {
      const { text: plainText, textStyles } = parseMarkdownToSignal(text);

      if (textStyles.length > 0) {
        // Bypass signal-sdk's textStyles mapping (it converts to objects,
        // but signal-cli's JSON-RPC expects "start:length:STYLE" strings).
        const params: Record<string, unknown> = {
          message: plainText,
          account: this.botPhone,
          textStyles: textStyles.map(
            (s) => `${s.start}:${s.length}:${s.style}`,
          ),
        };
        if (this.isGroupId(recipient)) {
          params.groupId = recipient;
        } else {
          params.recipients = [recipient];
        }
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await (this.signal as any).sendJsonRpcRequest('send', params);
      } else {
        await this.signal.sendMessage(recipient, plainText);
      }

      logger.info(
        {
          jid,
          recipient,
          isGroup,
          length: plainText.length,
          styles: textStyles.length,
        },
        'Signal: message sent',
      );
    } catch (err) {
      this.outgoingQueue.push({ phone: recipient, text });
      logger.warn(
        { jid, err, queueSize: this.outgoingQueue.length },
        'Signal: send failed, message queued',
      );
    }
  }

  async disconnect(): Promise<void> {
    this.backoffManager.shutdown();
    this.connected = false;
    await this.signal.gracefulShutdown();
    logger.info('Signal: disconnected');
  }

  async setTyping(jid: string, isTyping: boolean): Promise<void> {
    try {
      const rawId = jidToPhone(jid);
      const isGroup = this.isGroupId(rawId);
      const recipient = isGroup
        ? rawId
        : rawId === this.botPhone && this.userPhone
          ? this.userPhone
          : rawId;
      // sendTyping(recipient, stop?) — stop is the inverse of isTyping
      await this.signal.sendTyping(recipient, !isTyping);
    } catch (err) {
      logger.debug({ jid, err }, 'Signal: failed to send typing indicator');
    }
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /**
   * Check if a raw ID (after stripping signal: prefix) is a Signal group ID.
   * Signal group IDs are base64-encoded and contain =, /, or non-leading +.
   */
  private isGroupId(id: string): boolean {
    return (
      id.includes('=') ||
      id.includes('/') ||
      (id.includes('+') && !id.startsWith('+'))
    );
  }

  private isDirectMention(text: string): boolean {
    const name = ASSISTANT_NAME.toLowerCase();
    const lower = text.toLowerCase();
    return (
      lower.includes(`@${name}`) ||
      lower.startsWith(`${name},`) ||
      lower.startsWith(`${name} `)
    );
  }

  private isKnownBot(phone: string, name?: string): boolean {
    if (this.knownBots.has(phone)) return true;
    if (name && this.knownBotNames.has(name.toLowerCase())) return true;
    return false;
  }

  private async handleMessage(params: unknown): Promise<void> {
    const p = params as Record<string, unknown>;
    const envelope = p?.envelope as Record<string, unknown> | undefined;
    if (!envelope) return;

    // source may be a UUID (primary mode) or phone number (linked mode)
    const source = (envelope.sourceNumber ?? envelope.source ?? '') as string;
    const sourceName = (envelope.sourceName ?? source) as string;
    const timestamp = new Date(
      Number(envelope.timestamp) || Date.now(),
    ).toISOString();

    // Intercept typing indicators for group backoff coordination
    const typingMsg = envelope.typingMessage as
      | Record<string, unknown>
      | undefined;
    if (typingMsg) {
      const action = typingMsg.action as string; // "STARTED" or "STOPPED"
      const groupId = typingMsg.groupId as string | undefined;
      if (groupId && this.isKnownBot(source, sourceName)) {
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

    let chatPhone: string;
    let text: string | undefined;
    let attachments: unknown[] = [];
    let isFromMe = false;
    let isBotMessage = false;

    if (syncMsg) {
      // syncMessage.sentMessage = message synced from another device (phone).
      // signal-cli receives syncs for ALL conversations (groups, DMs, Note to Self).
      // We only care about Note to Self (destination = own number) and bot echoes.
      // Skip syncs for other conversations to avoid triggering the agent.
      const sent = syncMsg.sentMessage as Record<string, unknown> | undefined;
      if (!sent) return;

      chatPhone = (sent.destinationNumber ??
        sent.destination ??
        source) as string;

      // Only process messages destined for our own number (Note to Self / bot echo)
      // Skip syncs for group chats and other DMs
      if (chatPhone !== this.botPhone) return;

      text = sent.message as string | undefined;
      attachments = (sent.attachments as unknown[]) ?? [];
      isBotMessage =
        typeof text === 'string' && text.startsWith(`${ASSISTANT_NAME}:`);
      isFromMe = !isBotMessage;
    } else if (dataMsg) {
      const groupInfo = dataMsg.groupInfo as
        | Record<string, unknown>
        | undefined;
      if (groupInfo?.groupId) {
        // Group message — use group ID as the chat identifier
        chatPhone = groupInfo.groupId as string;
      } else {
        // DM — In primary device mode, DMs arrive as dataMessages.
        // Use the bot's own number as chatPhone — the registered JID matches this.
        // Replies are routed to SIGNAL_OWNER_PHONE via sendMessage().
        chatPhone = this.botPhone;
      }
      text = dataMsg.message as string | undefined;
      attachments = (dataMsg.attachments as unknown[]) ?? [];
      isFromMe = false;
      // Detect bot messages by assistant name prefix (fallback detection)
      isBotMessage =
        typeof text === 'string' && text.startsWith(`${ASSISTANT_NAME}:`);

      // Resolve Signal mentions: signal-cli uses U+FFFC (object replacement char)
      // as a placeholder for @mentions. Replace with @Name so trigger patterns match.
      const mentions = dataMsg.mentions as
        | Array<Record<string, unknown>>
        | undefined;
      if (text && mentions?.length) {
        for (const mention of mentions) {
          const mentionNumber = (mention.number ?? '') as string;
          const mentionUuid = (mention.uuid ?? '') as string;
          if (
            mentionNumber === this.botPhone ||
            mentionUuid === this.botPhone
          ) {
            text = text.replace('\uFFFC', `@${ASSISTANT_NAME}`);
          }
        }
      }
    } else {
      return;
    }

    // Find first audio attachment
    const audioAttachment = attachments.find((att) => {
      const a = att as Record<string, unknown>;
      return (
        typeof a.contentType === 'string' && a.contentType.startsWith('audio/')
      );
    }) as Record<string, unknown> | undefined;

    // Find image attachments
    const imageAttachments = attachments.filter((att) => {
      const a = att as Record<string, unknown>;
      return (
        typeof a.contentType === 'string' && a.contentType.startsWith('image/')
      );
    }) as Array<Record<string, unknown>>;

    // Skip protocol-only messages — no text, no audio, no images
    if (!text && !audioAttachment && imageAttachments.length === 0) return;

    const chatJid = phoneToJid(chatPhone);

    // Always emit metadata for chat discovery
    const isGroup = this.isGroupId(jidToPhone(chatJid));
    this.opts.onChatMetadata(chatJid, timestamp, sourceName, 'signal', isGroup);

    // Only deliver full message to registered groups
    const groups = this.opts.registeredGroups();
    if (!groups[chatJid]) return;

    let finalContent = text ?? '';

    // Handle voice/audio transcription
    if (audioAttachment) {
      // signal-cli stores downloaded attachments at ~/.local/share/signal-cli/attachments/<id>
      // The SDK event provides id/filename but not the full local path, so we resolve it.
      const attId = audioAttachment.id as string | undefined;
      const signalAttachDir = path.join(
        os.homedir(),
        '.local',
        'share',
        'signal-cli',
        'attachments',
      );
      const localPath =
        attId && fs.existsSync(path.join(signalAttachDir, attId))
          ? path.join(signalAttachDir, attId)
          : (audioAttachment.localPath as string | undefined);

      if (!localPath) {
        logger.warn(
          { attId, keys: Object.keys(audioAttachment) },
          'Signal: audio attachment has no resolvable local path',
        );
        finalContent = '[Voice Message - transcription unavailable]';
      } else {
        try {
          const transcript = await transcribeAudioFile(localPath);
          if (transcript) {
            finalContent = `[Voice: ${transcript}]`;
            logger.info(
              { chatJid, length: transcript.length },
              'Signal: voice transcribed',
            );
          } else {
            finalContent = '[Voice Message - transcription unavailable]';
          }
        } catch (err) {
          logger.error({ err }, 'Signal: voice transcription error');
          finalContent = '[Voice Message - transcription failed]';
        }
      }
    }

    // Handle image attachments
    if (imageAttachments.length > 0) {
      const group = groups[chatJid];
      const groupDir = group ? resolveGroupFolderPath(group.folder) : null;

      for (const imgAtt of imageAttachments) {
        const attId = imgAtt.id as string | undefined;
        const signalAttachDir = path.join(
          os.homedir(),
          '.local',
          'share',
          'signal-cli',
          'attachments',
        );
        const localPath =
          attId && fs.existsSync(path.join(signalAttachDir, attId))
            ? path.join(signalAttachDir, attId)
            : (imgAtt.localPath as string | undefined);

        if (!localPath || !groupDir) {
          logger.warn(
            { attId, hasGroupDir: !!groupDir },
            'Signal: image attachment has no resolvable local path',
          );
          finalContent += '\n[Image - unavailable]';
          continue;
        }

        try {
          const buffer = fs.readFileSync(localPath);
          const result = await processImage(buffer, groupDir, '');
          if (result) {
            finalContent = finalContent
              ? `${finalContent}\n${result.content}`
              : result.content;
            logger.info(
              { chatJid, relativePath: result.relativePath },
              'Signal: image processed',
            );
          } else {
            finalContent += '\n[Image - processing failed]';
          }
        } catch (err) {
          logger.error({ err }, 'Signal: image processing error');
          finalContent += '\n[Image - processing failed]';
        }
      }
    }

    const id = `signal-${chatPhone}-${envelope.timestamp ?? Date.now()}`;
    const message: NewMessage = {
      id,
      chat_jid: chatJid,
      sender: phoneToJid(source),
      sender_name: sourceName,
      content: finalContent,
      timestamp,
      is_from_me: isFromMe,
      is_bot_message: isBotMessage,
    };

    // Group messages from others go through backoff (unless direct mention)
    if (isGroup && !isFromMe && !this.isDirectMention(finalContent)) {
      this.backoffManager.onGroupMessage(chatJid, message);
      return;
    }

    this.opts.onMessage(chatJid, message);
  }

  private async flushOutgoingQueue(): Promise<void> {
    if (this.flushing || this.outgoingQueue.length === 0) return;
    this.flushing = true;
    try {
      logger.info(
        { count: this.outgoingQueue.length },
        'Signal: flushing outgoing message queue',
      );
      while (this.outgoingQueue.length > 0) {
        const item = this.outgoingQueue.shift()!;
        const { text: plainText, textStyles } = parseMarkdownToSignal(
          item.text,
        );
        if (textStyles.length > 0) {
          const params: Record<string, unknown> = {
            message: plainText,
            account: this.botPhone,
            textStyles: textStyles.map(
              (s) => `${s.start}:${s.length}:${s.style}`,
            ),
          };
          if (this.isGroupId(item.phone)) {
            params.groupId = item.phone;
          } else {
            params.recipients = [item.phone];
          }
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          await (this.signal as any).sendJsonRpcRequest('send', params);
        } else {
          await this.signal.sendMessage(item.phone, plainText);
        }
        logger.info({ phone: item.phone }, 'Signal: queued message sent');
      }
    } finally {
      this.flushing = false;
    }
  }
}

// ---------------------------------------------------------------------------
// Factory registration — runs at module load time
// ---------------------------------------------------------------------------

registerChannel('signal', (opts: ChannelOpts) => {
  const { botPhone } = getSignalEnv();
  if (!botPhone) {
    logger.warn('Signal: not configured. Run /add-signal to set up.');
    return null;
  }
  return new SignalChannel(opts);
});
