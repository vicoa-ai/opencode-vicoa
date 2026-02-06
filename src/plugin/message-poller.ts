/**
 * Polls Vicoa backend for user messages and sends them to OpenCode
 *
 * This mimics the Claude wrapper's message queue and polling functionality.
 */

import type { VicoaClient } from './vicoa-client.js';

export class MessagePoller {
  private client: VicoaClient;
  private interval: NodeJS.Timeout | null = null;
  private pollIntervalMs: number;
  private onMessage: (content: string) => Promise<void>;
  private log: (level: string, msg: string) => void;

  constructor(
    client: VicoaClient,
    onMessage: (content: string) => Promise<void>,
    logFunc?: (level: string, msg: string) => void,
    pollIntervalMs: number = 1000
  ) {
    this.client = client;
    this.onMessage = onMessage;
    this.pollIntervalMs = pollIntervalMs;
    this.log = logFunc || ((level, msg) => console.log(`[${level}] ${msg}`));
  }

  start(): void {
    if (this.interval) {
      return;
    }

    this.log('info', 'Starting message poller');

    this.interval = setInterval(async () => {
      try {
        const messages = await this.client.getPendingMessages();

        for (const msg of messages) {
          if (msg.sender_type === 'USER' && msg.content) {
            this.log('debug', `Received user message: ${msg.content.substring(0, 100)}...`);
            await this.onMessage(msg.content);
          }
        }
      } catch (error) {
        this.log('warn', `Error polling messages: ${error}`);
      }
    }, this.pollIntervalMs);
  }

  stop(): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
      this.log('info', 'Stopped message poller');
    }
  }
}
