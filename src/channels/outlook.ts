import { getRouterState, setRouterState } from '../db.js';
import { readEnvFile } from '../env.js';
import { logger } from '../logger.js';
import {
  fetchDelta,
  getUserEmail,
  loadOutlookCredentials,
  markAsRead,
  OutlookCredentials,
  refreshAccessToken,
} from '../outlook-graph.js';
import { Channel, NewMessage } from '../types.js';
import { ChannelOpts, registerChannel } from './registry.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const OUTLOOK_PREFIX = 'outlook:';
const POLL_INTERVAL_MS = 60_000;
const DELTA_TOKEN_KEY = 'outlook_delta_token';

// ---------------------------------------------------------------------------
// Channel implementation
// ---------------------------------------------------------------------------

export class OutlookChannel implements Channel {
  name = 'outlook';

  private opts: ChannelOpts;
  private connected = false;
  private pollTimer: NodeJS.Timeout | null = null;
  private creds: OutlookCredentials;
  private userEmail = '';
  /** When set, emails are delivered to this JID instead of the outlook JID. */
  private deliverToJid: string | null;

  constructor(
    opts: ChannelOpts,
    creds: OutlookCredentials,
    deliverToJid: string | null,
  ) {
    this.opts = opts;
    this.creds = creds;
    this.deliverToJid = deliverToJid;
  }

  async connect(): Promise<void> {
    try {
      this.creds = await refreshAccessToken(this.creds);
    } catch (err) {
      logger.error(
        { err },
        'Outlook: token refresh failed during connect — channel disabled',
      );
      this.connected = false;
      return;
    }

    try {
      this.userEmail = await getUserEmail(this.creds.accessToken);
    } catch (err) {
      logger.error(
        { err },
        'Outlook: failed to fetch user email — channel disabled',
      );
      this.connected = false;
      return;
    }

    this.connected = true;
    logger.info({ userEmail: this.userEmail }, 'Outlook channel connected');

    // Initial poll then recurring
    this.poll().catch((err) =>
      logger.error({ err }, 'Outlook: initial poll failed'),
    );

    this.pollTimer = setInterval(() => {
      this.poll().catch((err) => logger.error({ err }, 'Outlook: poll failed'));
    }, POLL_INTERVAL_MS);
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    if (this.pollTimer !== null) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    logger.info('Outlook channel disconnected');
  }

  isConnected(): boolean {
    return this.connected;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith(OUTLOOK_PREFIX);
  }

  async sendMessage(_jid: string, _text: string): Promise<void> {
    logger.debug(
      { jid: _jid, length: _text.length },
      'Outlook: sendMessage is a no-op — outbound email handled via MCP tools',
    );
  }

  // ---------------------------------------------------------------------------
  // Polling
  // ---------------------------------------------------------------------------

  private async poll(): Promise<void> {
    // Refresh token before each poll if needed
    try {
      this.creds = await refreshAccessToken(this.creds);
    } catch (err) {
      logger.error(
        { err },
        'Outlook: token refresh failed — disconnecting channel',
      );
      await this.disconnect();
      return;
    }

    const storedDelta = getRouterState(DELTA_TOKEN_KEY) ?? null;

    let deltaResult;
    try {
      deltaResult = await fetchDelta(this.creds.accessToken, storedDelta);
    } catch (err) {
      logger.error({ err }, 'Outlook: fetchDelta failed');
      return;
    }

    const { emails, deltaLink } = deltaResult;

    if (emails.length > 0) {
      logger.info({ count: emails.length }, 'Outlook: processing new emails');
    }

    const outlookJid = `${OUTLOOK_PREFIX}${this.userEmail}`;
    const targetJid = this.deliverToJid ?? outlookJid;
    const groups = this.opts.registeredGroups();

    for (const email of emails) {
      const senderAddress = email.from?.emailAddress?.address ?? '';
      const senderName = email.from?.emailAddress?.name ?? senderAddress;
      const sender = `${OUTLOOK_PREFIX}${senderAddress}`;

      // Always call onChatMetadata for chat discovery (use outlook JID)
      this.opts.onChatMetadata(
        outlookJid,
        email.receivedDateTime,
        'Outlook Inbox',
        'outlook',
        false,
      );

      // Deliver to the target group (may be a different channel, e.g. Signal)
      if (!groups[targetJid]) {
        logger.debug(
          { targetJid },
          'Outlook: target group not registered, skipping message delivery',
        );
      } else {
        const content =
          `[EMAIL] From: ${senderName} <${senderAddress}>\n` +
          `Subject: ${email.subject ?? '(no subject)'}\n` +
          `Preview: ${email.bodyPreview ?? ''}\n` +
          `[Email ID: ${email.id}]`;

        const message: NewMessage = {
          id: `outlook-${email.id}`,
          chat_jid: targetJid,
          sender,
          sender_name: `Email: ${senderName}`,
          content,
          timestamp: email.receivedDateTime,
          is_from_me: false,
          is_bot_message: false,
        };

        this.opts.onMessage(targetJid, message);
      }

      // Mark as read regardless of registration to prevent re-processing
      try {
        await markAsRead(this.creds.accessToken, email.id);
        logger.debug({ emailId: email.id }, 'Outlook: marked email as read');
      } catch (err) {
        logger.warn(
          { err, emailId: email.id },
          'Outlook: failed to mark email as read',
        );
      }
    }

    // Persist updated delta token
    if (deltaLink) {
      setRouterState(DELTA_TOKEN_KEY, deltaLink);
    }
  }
}

// ---------------------------------------------------------------------------
// Factory registration
// ---------------------------------------------------------------------------

registerChannel('outlook', (opts: ChannelOpts) => {
  const creds = loadOutlookCredentials();
  if (!creds) {
    logger.warn('Outlook: not configured. Run /add-outlook to set up.');
    return null;
  }
  const env = readEnvFile(['OUTLOOK_DELIVER_TO']);
  const deliverTo =
    process.env.OUTLOOK_DELIVER_TO || env.OUTLOOK_DELIVER_TO || null;
  if (deliverTo) {
    logger.info(
      { deliverTo },
      'Outlook: emails will be delivered to alternate group',
    );
  }
  return new OutlookChannel(opts, creds, deliverTo);
});
