/**
 * opencode-vicoa
 *
 * OpenCode plugin that integrates with Vicoa web & mobile
 * - Real-time session monitoring
 * - Bidirectional messaging (UI ↔ agent)
 * - Permission request forwarding
 * - Tool execution tracking
 * - Session state management
 *
 * This plugin runs INSIDE OpenCode and directly calls Vicoa REST APIs,
 * eliminating the need for a separate Python wrapper process.
 */

import type { Plugin } from '@opencode-ai/plugin';
import type { FilePart, Part, Permission, ReasoningPart, TextPart, ToolPart } from '@opencode-ai/sdk';
import { VicoaClient } from './plugin/vicoa-client.js';
import { MessagePoller } from './plugin/message-poller.js';
import { getApiKey } from './plugin/credentials.js';
import { formatFilePart, formatReasoningPart, formatToolPart } from './plugin/format-utils.js';
import {
  buildPermissionOptions,
  formatPermissionRequest,
  parsePermissionReply,
  type PermissionOption,
} from './plugin/permission.js';
import { randomUUID } from 'crypto';
import * as os from 'os';
import {
  OPENCODE_SLASH_AGENT_TYPE,
  handleSlashCommand,
  scanOpencodeCommands,
  type OpencodeCommandMap,
} from './plugin/commands.js';
import { handleControlCommand } from './plugin/control.js';
import { log } from './plugin/utils.js';
import { formatProjectPath } from './plugin/path-utils.js';

/**
 * Plugin version - increment on changes
 */
const PLUGIN_VERSION = '0.1.0';

let lastSessionTitle: string | null = null;
let currentSessionId: string | undefined;
let preferredAgent: string | undefined;

// The agent that the TUI *thinks* is active.  Updated every time we see a
// user-role message.updated event (the UserMessage.agent field is the agent
// the TUI sent that message with).  Used to compute how many agent.cycle
// steps are needed to land on a target agent.
let tuiCurrentAgent: string | undefined;

// Track messages that came from the UI (to avoid sending them back)
// Keep a simple FIFO buffer of message content
const messagesFromUI: string[] = [];
const MAX_UI_MESSAGES = 50;

// ── pending permission state ──────────────────────────────────────────────
// When a permission.asked event arrives we forward it to Vicoa as a
// requires_user_input message and record the permission here so that when
// the user's reply comes back through the poller we can call OpenCode's
// permission-reply API instead of forwarding the text as a prompt.
interface PendingPermission {
  permission: Permission;
  options: PermissionOption[];           // the exact options we sent to the UI
  vicoaMessageId: string | null;         // the Vicoa message we sent (for logging)
}
const pendingPermissions = new Map<string, PendingPermission>();

// Track assistant message IDs we've already forwarded to Vicoa (avoid duplicates)
const sentAssistantMessageIds = new Set<string>();
const sentAssistantMessageQueue: string[] = [];
const MAX_SENT_MESSAGE_IDS = 200;

type MessagePartsState = {
  order: string[];
  parts: Map<string, string>;
  textByPartId: Map<string, string>;
};

// Track message parts by ID (for incremental updates)
const messagePartsById = new Map<string, MessagePartsState>();

function getMessageState(messageId: string): MessagePartsState {
  let state = messagePartsById.get(messageId);
  if (!state) {
    state = { order: [], parts: new Map(), textByPartId: new Map() };
    messagePartsById.set(messageId, state);
  }
  return state;
}

function setPartContent(state: MessagePartsState, partId: string, content: string | null) {
  if (!state.order.includes(partId)) {
    state.order.push(partId);
  }

  if (!content) {
    state.parts.delete(partId);
    return;
  }

  state.parts.set(partId, content);
}

function formatToolPartSafe(part: ToolPart): string {
  try {
    return formatToolPart(part);
  } catch {
    return `Using tool: ${part.tool}`;
  }
}

function formatFilePartSafe(part: FilePart): string {
  try {
    return formatFilePart(part);
  } catch {
    return part.filename ? `File: \`${part.filename}\`` : 'File attached';
  }
}


function formatReasoningPartSafe(part: ReasoningPart): string {
  try {
    return formatReasoningPart(part);
  } catch {
    return '';
  }
}

function buildMessageContent(messageId: string): string {
  const state = messagePartsById.get(messageId);
  if (!state) {
    return '';
  }

  const parts = state.order
    .map((partId) => state.parts.get(partId))
    .filter((part): part is string => Boolean(part && part.trim().length));

  return parts.join('\n\n').trim();
}

// Accumulates non-tool parts into the per-message state for later assembly.
// Tool parts are intentionally excluded — they are flushed as individual
// messages by the event handler as soon as they reach a terminal state.
function handlePartUpdate(part: Part, delta?: string) {
  if (!('messageID' in part) || !part.messageID) {
    return;
  }

  const state = getMessageState(part.messageID);

  switch (part.type) {
    case 'text': {
      const currentText = state.textByPartId.get(part.id) || '';
      const nextText = typeof delta === 'string' ? currentText + delta : part.text || currentText;
      state.textByPartId.set(part.id, nextText);
      setPartContent(state, part.id, nextText);
      return;
    }

    // file parts — keep images (useful in UI), drop everything else
    // (source dumps are noise; the tool usage line already names the file)
    case 'file':
      if (part.mime?.startsWith('image/') && part.url) {
        setPartContent(state, part.id, formatFilePartSafe(part));
      }
      return;

    // patch parts are internal bookkeeping — skip them entirely
    case 'patch':
      return;

    case 'reasoning': {
      const content = formatReasoningPartSafe(part);
      setPartContent(state, part.id, content);
      return;
    }

    // tool parts handled separately in the event handler
    default:
      return;
  }
}

// When the user types @filename or @folder, OpenCode resolves it by calling
// the read/list tool and appending the result into the user message. Forms:
//   1) "Called the Read tool with the following input: {…}\n<file>…</file>"
//   2) bare "<file>…</file>" blocks (sometimes without the header)
//   3) unclosed "<file>" tag followed by content (when both folder + file selected)
//   4) directory listings (folder tree with indented file names)
// Strip all of these so only the real prompt survives.
const TOOL_RESULT_HEADER = /Called the \w+ tool with the following input:[\s\S]*/;
const FILE_BLOCK = /<file>[\s\S]*?<\/file>/g;
const UNCLOSED_FILE_TAG = /<file>[\s\S]*/g;  // Match <file> tag without closing
const DIRECTORY_LISTING = /^\/[^\n]+\/\n(?:[ \t]+[^\n]+\n)+/gm;  // Match directory tree structure

function stripToolResults(text: string): string {
  let cleaned = text;

  // Strip tool result headers
  cleaned = cleaned.replace(TOOL_RESULT_HEADER, '');

  // Strip closed file blocks first
  cleaned = cleaned.replace(FILE_BLOCK, '');

  // Strip unclosed file tags with content (must come after closed blocks)
  cleaned = cleaned.replace(UNCLOSED_FILE_TAG, '');

  // Strip directory listings (folder path + indented file list)
  cleaned = cleaned.replace(DIRECTORY_LISTING, '');

  return cleaned;
}

function normalizeMessage(content: string): string {
  return content.replace(/\r\n/g, '\n').trim();
}

// Helper to add UI message with size limit (FIFO eviction)
function addUIMessage(content: string) {
  messagesFromUI.push(normalizeMessage(content));

  // If buffer exceeds limit, remove first 40 messages
  if (messagesFromUI.length > MAX_UI_MESSAGES) {
    messagesFromUI.splice(0, 40);
  }
}

// Helper to check and remove UI message
function isFromUI(content: string): boolean {
  content = normalizeMessage(content);
  const index = messagesFromUI.indexOf(content);
  if (index !== -1) {
    messagesFromUI.splice(index, 1); // Remove it immediately
    return true;
  }
  return false;
}

function trackSentMessage(set: Set<string>, queue: string[], messageId: string) {
  if (set.has(messageId)) {
    return;
  }
  set.add(messageId);
  queue.push(messageId);

  if (queue.length > MAX_SENT_MESSAGE_IDS) {
    const evicted = queue.shift();
    if (evicted) {
      set.delete(evicted);
    }
  }
}


async function sendAgentSwitchToUi(
  vicoaClient: VicoaClient,
  logClient: (level: 'debug' | 'info' | 'warn' | 'error', message: string) => void,
  agentName: string,
): Promise<void> {
  const controlPayload = JSON.stringify({ type: 'control', setting: 'agent_type', value: agentName.toLowerCase() });
  await vicoaClient.sendMessage(`Agent changed to ${agentName}. ${controlPayload}`);
  logClient('info', `[Vicoa] Forwarded terminal agent change to UI: ${agentName}`);
}

export const VicoaPlugin: Plugin = async (context) => {
  const { client, directory } = context;

  // Get API key from environment or credentials file
  const apiKey = getApiKey();
  const baseUrl = process.env.VICOA_API_URL || process.env.VICOA_BASE_URL || 'https://api.vicoa.ai:8443';

  if (!apiKey) {
    log(client, 'warn', `[Vicoa v${PLUGIN_VERSION}] Disabled: No API key found`);
    log(client, 'info', '[Vicoa] Set VICOA_API_KEY environment variable or run "vicoa --auth" to authenticate');
    return {};
  }

  log(client, 'info', `[Vicoa v${PLUGIN_VERSION}] Initializing...`);

  // Generate or reuse agent instance ID
  const agentInstanceId = process.env.VICOA_AGENT_INSTANCE_ID || randomUUID();
  const agentName = process.env.VICOA_AGENT_NAME || 'OpenCode';

  // Create Vicoa client
  const vicoaClient = new VicoaClient({
    apiKey,
    baseUrl,
    agentType: agentName,
    agentInstanceId,
    logFunc: (level: string, msg: string) => {
      const logLevel = (level as 'debug' | 'info' | 'warn' | 'error') || 'info';
      log(client, logLevel, `[Vicoa] ${msg}`);
    },
  });

  // Register agent instance
  try {
    const projectPath = directory || process.cwd();
    const homeDir = os.homedir();

    // Format project path to use ~ for home directory (consistent with Claude wrapper)
    const formattedProjectPath = formatProjectPath(projectPath);
    await vicoaClient.registerAgentInstance(formattedProjectPath, homeDir);
    log(client, "info", `[Vicoa] Registered session: ${agentInstanceId}`);

    // Send initial message
    await vicoaClient.sendMessage('OpenCode session started, waiting for your input...');

    try {
      const opencodeCommands = await scanOpencodeCommands(projectPath, homeDir);
      const count = Object.keys(opencodeCommands).length;
      if (count > 0) {
        await vicoaClient.syncCommands(OPENCODE_SLASH_AGENT_TYPE, opencodeCommands);
        log(client, "info", `[Vicoa] Synced ${count} OpenCode slash commands`);
      }
    } catch (error) {
      log(client, "warn", `[Vicoa] Failed to sync OpenCode slash commands: ${error}`);
    }
  } catch (error) {
    log(client, "error", `[Vicoa] Failed to register: ${error}`);
    return {};
  }

  // Start polling for user messages
  const messagePoller = new MessagePoller(
    vicoaClient,
    async (userMessage) => {
      log(client, "info", `[Vicoa] Received message from dashboard: ${userMessage.substring(0, 80)}${userMessage.length > 80 ? '...' : ''}`);

      // Check if it's a control command (matches Claude wrapper pattern)
      if (
        await handleControlCommand(userMessage, {
          client,
          vicoaClient,
          currentSessionId,
          getTuiCurrentAgent: () => tuiCurrentAgent,
          setTuiCurrentAgent: (agent) => {
            tuiCurrentAgent = agent;
          },
          setPreferredAgent: (agent) => {
            preferredAgent = agent;
          },
        })
      ) {
        await vicoaClient.updateStatus('AWAITING_INPUT');
        return; // Control command handled
      }

      // ── permission reply interception ───────────────────────────────
      // If there is a pending permission and the user's message matches one
      // of the options we sent, reply via OpenCode's permission API instead
      // of forwarding as a chat prompt.
      for (const [permId, pending] of pendingPermissions) {
        const matched = parsePermissionReply(userMessage, pending.options);
        if (!matched) continue;

        log(client, 'info', `[Vicoa] Replying to permission ${permId} with "${matched}"`);
        try {
          await client.postSessionIdPermissionsPermissionId({
            path: {
              id: pending.permission.sessionID,
              permissionID: permId,
            },
            body: { response: matched },
          });
          log(client, 'info', `[Vicoa] Permission ${permId} replied successfully`);
        } catch (error) {
          log(client, 'error', `[Vicoa] Failed to reply to permission ${permId}: ${error}`);
        }
        pendingPermissions.delete(permId);
        return; // Do NOT forward this message as a prompt
      }

      if (
        await handleSlashCommand(
          userMessage,
          client,
          currentSessionId,
          vicoaClient
        )
      ) {
        return;
      }

      // Submit as a prompt via the TUI. Mark it first so the chat.message
      // hook doesn't echo it back to Vicoa.
      addUIMessage(userMessage);
      await client.tui.appendPrompt({ body: { text: userMessage } });

      // A trailing space is needed for @ mentions and slash commands so
      // OpenCode resolves them before submitting.
      if (userMessage.includes('@') || userMessage.startsWith('/')) {
        await client.tui.appendPrompt({ body: { text: ' ' } });
      }

      await client.tui.submitPrompt();
      log(client, "info", `[Vicoa] Executed prompt in OpenCode: ${userMessage.substring(0, 80)}...`);
    },
    (level: string, msg: string) => log(client, "info", msg)
  );

  messagePoller.start();

  return {
    event: async ({ event }) => {
      try {
        switch (event.type) {
          // ── message streaming ─────────────────────────────────────
          case 'message.part.updated': {
            const { part, delta } = event.properties;

            // Tool parts are sent as their own messages once they finish,
            // rather than being folded into the surrounding assistant text.
            if (part.type === 'tool') {
              const status = part.state.status;
              if (status === 'completed' || status === 'error') {
                // read/grep/glob/… — only show the usage line, no result
                const formatted = formatToolPartSafe(part);
                if (formatted) {
                  await vicoaClient.sendMessage(formatted);
                }
              }
              // pending / running — nothing to send yet
              return;
            }

            handlePartUpdate(part, delta);
            return;
          }

          // ── completed assistant message forwarding ────────────────
          case 'message.updated': {
            const message = event.properties.info;

            // User messages carry the agent the TUI used — track it so that
            // cycleTuiToAgent knows where the indicator currently is.
            // This is the only reliable signal for terminal-side agent changes
            // (keybind cycles, /agent commands, etc.) because command.executed
            // does not fire for TUI-dispatched commands.
            if (message.role === 'user' && (message as any).agent) {
              const reportedAgent = (message as any).agent as string;
              const previousAgent = tuiCurrentAgent;
              tuiCurrentAgent = reportedAgent;
              preferredAgent = reportedAgent;

              if (previousAgent !== reportedAgent) {
                void sendAgentSwitchToUi(
                  vicoaClient,
                  (level, message) => log(client, level, message),
                  reportedAgent,
                );
              }
            }

            // message.updated fires on every update (user messages, intermediate
            // assistant updates without completed, etc.).  Only act — and only
            // clean up accumulated part state — once the assistant message has
            // actually finished.
            if (message.role !== 'assistant' || !message.time?.completed) return;

            const trimmedText = buildMessageContent(message.id);
            messagePartsById.delete(message.id);

            if (trimmedText.length > 0 && !sentAssistantMessageIds.has(message.id)) {
              await vicoaClient.sendMessage(trimmedText);
              trackSentMessage(sentAssistantMessageIds, sentAssistantMessageQueue, message.id);
            }
            return;
          }

          // ── session lifecycle ─────────────────────────────────────
          case 'session.created': {
            const session = event.properties.info;
            lastSessionTitle = session.title;
            currentSessionId = session.id;
            log(client, 'info', `[Vicoa] Session created: ${session.id}`);

            await vicoaClient.updateStatus('ACTIVE');
            return;
          }

          case 'session.updated': {
            const nextTitle = event.properties.info.title;
            if (nextTitle && nextTitle !== lastSessionTitle) {
              lastSessionTitle = nextTitle;
              await vicoaClient.updateAgentInstanceName(nextTitle);
              log(client, 'info', `[Vicoa] Updated session title: ${nextTitle}`);
            }
            return;
          }

          case 'session.deleted': {
            currentSessionId = undefined;
            await vicoaClient.endSession();
            return;
          }

          case 'session.idle': {
            log(client, 'info', '[Vicoa] Session idle');
            await vicoaClient.updateStatus('AWAITING_INPUT');

            if (vicoaClient.lastMessageId) {
              await vicoaClient.requestUserInput(vicoaClient.lastMessageId);
            }
            return;
          }
          
          case 'session.status': {
            const statusType = event.properties.status.type;

            if (statusType === 'busy' || statusType === 'retry') {
              await vicoaClient.updateStatus('ACTIVE');
            } else if (statusType === 'idle') {
              await vicoaClient.updateStatus('AWAITING_INPUT');
            }
            return;
          }

          case 'session.error': {
            const errorObj = event.properties.error;
            const errorMsg = errorObj && typeof errorObj === 'object' && 'message' in errorObj
              ? String(errorObj.message)
              : 'Unknown error';

            log(client, 'error', `[Vicoa] Session error: ${errorMsg}`);

            // Only send error message to UI if it's not the generic "Unknown error"
            if (errorMsg !== 'Unknown error') {
              // Check if it's a rate limiting error
              const errorMsgLower = errorMsg.toLowerCase();
              const isRateLimitError = errorMsgLower.includes('too many request') ||
                                       errorMsgLower.includes('rate limit') ||
                                       errorMsg.includes('429');

              if (isRateLimitError) {
                await vicoaClient.sendMessage(`Too Many Requests: Rate limit exceeded.`);
              } else {
                await vicoaClient.sendMessage(`Error: ${errorMsg}`);
              }
              await vicoaClient.updateStatus('AWAITING_INPUT');
            }

            return;
          }

          // ── permissions ───────────────────────────────────────────
          // OpenCode emits "permission.asked" at runtime (confirmed by bus
          // logs) even though the SDK typedef names it "permission.updated".
          // Handle both so we work regardless of SDK version drift.
          case 'permission.asked' as string: {
            const permission = event.properties as Permission;

            const options = buildPermissionOptions(permission);

            const messageId = await vicoaClient.sendMessage(
              formatPermissionRequest(permission, options),
              true, // requires_user_input
            );

            // Record so the poller callback can reply via OpenCode API
            pendingPermissions.set(permission.id, {
              permission,
              options,
              vicoaMessageId: messageId,
            });
            log(client, 'info', `[Vicoa] Tracked pending permission: ${permission.id}`);
            return;
          }

          case 'permission.replied' as string: {
            // Clean up — reply already sent by the poller handler
            const { permissionID } = event.properties as { sessionID: string; permissionID: string; response: string };
            pendingPermissions.delete(permissionID);
            log(client, 'debug', `[Vicoa] Cleaned up replied permission: ${permissionID}`);
            return;
          }

          // ── server ────────────────────────────────────────────────
          case 'server.connected': {
            log(client, 'info', '[Vicoa] OpenCode server connected');
            return;
          }

          // ── shutdown ──────────────────────────────────────────────
          // Fires before the process exits (/exit, app.exit, etc.).
          // This is the only path where the event loop is still live,
          // so async endSession() can actually complete.
          case 'server.instance.disposed' as string:
          case 'global.disposed' as string: {
            log(client, 'info', `[Vicoa] ${event.type} — ending session`);
            messagePoller.stop();
            try {
              await vicoaClient.endSession();
            } catch (error) {
              log(client, 'warn', `[Vicoa] endSession during dispose failed: ${error}`);
            }
            return;
          }

          default: {
            // Log unhandled events for debugging
            if (event.type.includes('error')) {
              log(client, 'warn', `[Vicoa] Unhandled error event: ${event.type}`);

              // Try to extract error message from various possible structures
              const props = event.properties as any;
              const errorMsg = props?.error?.message || props?.error || props?.message || 'Unknown error';
              const errorStr = typeof errorMsg === 'string' ? errorMsg : String(errorMsg);

              log(client, 'error', `[Vicoa] Error details: ${errorStr}`);

              // Check if it's a rate limit error
              const errorMsgLower = errorStr.toLowerCase();
              const isRateLimitError = errorMsgLower.includes('too many request') ||
                                       errorMsgLower.includes('rate limit') ||
                                       errorStr.includes('429');

              if (isRateLimitError) {
                await vicoaClient.sendMessage(`Too Many Requests: Rate limit exceeded.`);
              } else if (errorStr !== 'Unknown error') {
                await vicoaClient.sendMessage(`Error: ${errorStr}`);
              }

              await vicoaClient.updateStatus('AWAITING_INPUT');
            }
            return;
          }
        }
      } catch (error) {
        log(client, 'error', `[Vicoa] Error in event hook: ${error}`);
      }
    },

    'chat.message': async (input, output) => {
      try {
        const { message, parts } = output;

        if (message.role === 'user' && parts.length > 0) {
          // Keep only TextParts.  From each one strip any tool-result block
          // that OpenCode appends (e.g. @filename resolution injects
          // "Called the Read tool …\n<file>…</file>").  Non-text parts
          // (auto-attached context files) are ignored entirely.
          const fullText = parts
            .filter((part): part is TextPart => part.type === 'text')
            .map((part) => stripToolResults(part.text))
            .filter((text) => text.trim().length > 0)
            .join('\n');

          if (fullText.length === 0) return;

          if (isFromUI(fullText)) {
            log(client, 'debug', `[Vicoa] Skipping message from UI: ${fullText.substring(0, 80)}...`);
            return;
          }

          log(client, 'info', `[Vicoa] User message from terminal: ${fullText.substring(0, 80)}${fullText.length > 80 ? '...' : ''}`);
          await vicoaClient.sendUserMessage(fullText);
        }
      } catch (error) {
        log(client, 'error', `[Vicoa] Error in chat.message hook: ${error}`);
      }
    },

    'tool.execute.before': async (input) => {
      log(client, 'debug', `[Vicoa] Tool executing: ${input.tool}`);
    },

    'tool.execute.after': async (input) => {
      log(client, 'debug', `[Vicoa] Tool completed: ${input.tool}`);
    },
  };
};

export default VicoaPlugin;
