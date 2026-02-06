/**
 * Shared utility functions for the OpenCode Vicoa plugin
 */

/**
 * Helper to log messages using OpenCode's app.log format
 */
export function log(client: any, level: 'debug' | 'info' | 'warn' | 'error', message: string): void {
  client.app.log({
    body: {
      service: 'vicoa',
      level,
      message,
    },
  });
}
