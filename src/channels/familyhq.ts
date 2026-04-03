import http from 'http';

import { readEnvFile } from '../env.js';
import { logger } from '../logger.js';
import { Channel, NewMessage } from '../types.js';
import { ChannelOpts, registerChannel } from './registry.js';

const FAMILYHQ_PREFIX = 'familyhq:';
const DEFAULT_PORT = 3002;

export class FamilyHQChannel implements Channel {
  name = 'familyhq';

  private opts: ChannelOpts;
  private apiUrl: string;
  private apiSecret: string;
  private server: http.Server | null = null;
  private port: number;
  private connected = false;

  constructor(
    opts: ChannelOpts,
    apiUrl: string,
    apiSecret: string,
    port: number,
  ) {
    this.opts = opts;
    this.apiUrl = apiUrl;
    this.apiSecret = apiSecret;
    this.port = port;
  }

  async connect(): Promise<void> {
    this.server = http.createServer((req, res) => {
      if (req.method === 'POST' && req.url === '/inbound') {
        this.handleInbound(req, res);
      } else {
        res.writeHead(404);
        res.end('Not found');
      }
    });

    await new Promise<void>((resolve) => {
      this.server!.listen(this.port, () => {
        this.connected = true;
        logger.info({ port: this.port }, 'Family HQ channel listening');
        resolve();
      });
    });
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    const memberId = jid.replace(FAMILYHQ_PREFIX, '');

    try {
      const body = JSON.stringify({
        member_id: memberId,
        message: text,
        timestamp: new Date().toISOString(),
      });

      const url = new URL(`${this.apiUrl}/andy/webhook/reply`);
      const resp = await fetch(url.toString(), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Api-Secret': this.apiSecret,
        },
        body,
      });

      if (!resp.ok) {
        logger.error(
          { status: resp.status, memberId },
          'Family HQ: failed to send reply',
        );
      }
    } catch (err) {
      logger.error({ err, memberId }, 'Family HQ: error sending reply');
    }
  }

  isConnected(): boolean {
    return this.connected;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith(FAMILYHQ_PREFIX);
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    if (this.server) {
      await new Promise<void>((resolve) => this.server!.close(() => resolve()));
      this.server = null;
    }
    logger.info('Family HQ channel disconnected');
  }

  private handleInbound(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): void {
    const secret = req.headers['x-api-secret'] as string | undefined;
    if (secret !== this.apiSecret) {
      res.writeHead(401);
      res.end('Unauthorized');
      return;
    }

    let body = '';
    req.on('data', (chunk: Buffer) => {
      body += chunk.toString();
    });

    req.on('end', () => {
      try {
        const data = JSON.parse(body) as {
          member_id: string;
          member_name: string;
          message: string;
          timestamp?: string;
        };

        const chatJid = `${FAMILYHQ_PREFIX}${data.member_id}`;
        const timestamp = data.timestamp || new Date().toISOString();

        this.opts.onChatMetadata(
          chatJid,
          timestamp,
          `Family HQ: ${data.member_name}`,
          'familyhq',
          false,
        );

        const message: NewMessage = {
          id: `familyhq-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          chat_jid: chatJid,
          sender: chatJid,
          sender_name: data.member_name,
          content: data.message,
          timestamp,
          is_from_me: false,
          is_bot_message: false,
        };

        this.opts.onMessage(chatJid, message);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok' }));
      } catch (err) {
        logger.error({ err }, 'Family HQ: failed to parse inbound message');
        res.writeHead(400);
        res.end('Bad request');
      }
    });
  }
}

registerChannel('familyhq', (opts: ChannelOpts) => {
  const env = readEnvFile([
    'FAMILY_HQ_API_URL',
    'FAMILY_HQ_API_SECRET',
    'FAMILY_HQ_INBOUND_PORT',
  ]);

  const apiUrl = process.env.FAMILY_HQ_API_URL || env.FAMILY_HQ_API_URL || '';
  const apiSecret =
    process.env.FAMILY_HQ_API_SECRET || env.FAMILY_HQ_API_SECRET || '';
  const port = parseInt(
    process.env.FAMILY_HQ_INBOUND_PORT ||
      env.FAMILY_HQ_INBOUND_PORT ||
      String(DEFAULT_PORT),
    10,
  );

  if (!apiUrl || !apiSecret) {
    logger.warn(
      'Family HQ: FAMILY_HQ_API_URL or FAMILY_HQ_API_SECRET not set — channel disabled.',
    );
    return null;
  }

  return new FamilyHQChannel(opts, apiUrl, apiSecret, port);
});
