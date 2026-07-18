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
 * eliminating the need for a separate wrapper process.
 */

import type { Plugin } from '@opencode-ai/plugin';
import type { FilePart, Part, Permission, ReasoningPart, TextPart, ToolPart } from '@opencode-ai/sdk';
import { VicoaClient } from './plugin/vicoa-client.js';
import { SessionMessagesWsClient, deriveWsUrl } from './plugin/session-ws-client.js';
import { getApiKey } from './plugin/credentials.js';
import { readMachineId } from './plugin/machine-state.js';
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
 * Plugin version - keep in sync with package.json "version".
 * Reported to the backend as the X-CLI-Version header on the session
 * WebSocket, which gates SSE/poll-transport retirement telemetry.
 */
const PLUGIN_VERSION = '0.2.0';

let lastSessionTitle: string | null = null;
let currentSessionId: string | undefined;
let preferredAgent: string | undefined;

// The agent that the TUI *thinks* is active.  Updated every time we see a
// user-role message.updated event (the UserMessage.agent field is the agent
// the TUI sent that message with).  Used to compute how many agent.cycle
// steps are needed to land on a target agent.
let tuiCurrentAgent: string | undefined;

// The model slug ("providerID/modelID") last seen in a user message or set by
// a control command.  Used to detect TUI-side model changes so we can PATCH
// session_config without waiting for the next control command from the app.
let currentTuiModel: string | undefined;

// Track current session status to detect if OpenCode is idle
let currentSessionStatus: 'idle' | 'busy' | 'retry' | undefined;

// Sessions OpenCode spawned as children of the main one — the `task` tool
// gives each subagent its own session, and their lifecycle events are
// indistinguishable from the main session's except by id.
//
// They must not drive the Vicoa instance status: a subagent finishing emits
// session.idle / session.status:idle while the main session is still mid-turn,
// which would park the instance on AWAITING_INPUT (app shows "waiting for you"
// while the agent is visibly working) until the next status event happened to
// correct it. Only session.created/updated/deleted carry the Session object
// with its `parentID`, so record the children there and filter the id-only
// events against this set.
const childSessionIds = new Set<string>();

// The last agent message we flagged via requestUserInput. The endpoint 400s on
// a re-flag (see VicoaClient.requestUserInput), and session.idle can fire more
// than once for the same message — e.g. an interrupt lands with no new agent
// output, or the session settles idle again after a no-op turn.
let markedRequestInputId: string | null = null;

// Debounces the turn-end transition to one write per idle period. OpenCode
// signals the same settle twice (session.idle and session.status:idle) and the
// two are not interchangeable: settleAwaitingInput prefers requestUserInput,
// which deliberately leaves the instance ACTIVE when the user has typed ahead.
// Without this, the second event's plain AWAITING_INPUT write would clobber
// that decision. Reset when the session goes busy again.
let idleSettled = false;

function isChildSession(sessionId: string | undefined): boolean {
  return sessionId !== undefined && childSessionIds.has(sessionId);
}

/**
 * Settle the instance at the end of a turn — at most once per idle period.
 *
 * Flagging the last agent message is preferred over a plain status write: that
 * path is queued-message aware server-side, so a user who typed ahead keeps the
 * instance ACTIVE and gets no pointless "agent needs you" notification.
 */
async function settleAwaitingInput(vicoaClient: VicoaClient): Promise<void> {
  if (idleSettled) return;
  idleSettled = true;

  const messageId = vicoaClient.lastAgentMessageId;
  if (messageId && messageId !== markedRequestInputId) {
    markedRequestInputId = messageId;
    if (await vicoaClient.requestUserInput(messageId)) {
      return;
    }
    // Flagging failed, so it left the status alone — fall through rather than
    // leave the instance parked on ACTIVE with the turn already over. The
    // sibling idle event cannot cover for us; idleSettled is already set.
  }
  // Nothing to flag (no agent output this turn, or already flagged) — just make
  // sure the row is not left showing ACTIVE.
  await vicoaClient.updateStatus('AWAITING_INPUT');
}

/** Mark the instance as working. Re-arms the turn-end settle. */
async function markActive(vicoaClient: VicoaClient): Promise<void> {
  idleSettled = false;
  await vicoaClient.updateStatus('ACTIVE');
}

/**
 * Settle after an action the user drove from the app (control or slash
 * command), rather than after a model turn.
 *
 * Same AWAITING_INPUT destination, but deliberately via a plain status write:
 * the acknowledgement we just posted is not something to notify anyone about,
 * and the user is holding the phone they'd be pinged on. Marking the ack as
 * already-flagged is what suppresses that notification — the session.idle that
 * follows then finds nothing new to flag and settles quietly.
 *
 * Note this does NOT claim `idleSettled`. These commands can arrive mid-turn
 * (changing the model while the agent works), and swallowing that turn's real
 * settle would leave the instance stuck ACTIVE after it finished.
 */
async function settleAfterUserAction(vicoaClient: VicoaClient): Promise<void> {
  markedRequestInputId = vicoaClient.lastAgentMessageId;
  await vicoaClient.updateStatus('AWAITING_INPUT');
}

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

function startCommandSyncSubprogress(
  vicoaClient: VicoaClient,
  projectPath: string,
  homeDir: string,
  logClient: (level: 'debug' | 'info' | 'warn' | 'error', message: string) => void,
): void {
  // Run sync on a separate tick so plugin startup and poller wiring never wait
  // for command scan/sync work to even begin.
  setTimeout(() => {
    void (async () => {
      logClient('debug', '[Vicoa] [subprogress] Starting slash command sync');
      try {
        const opencodeCommands = await scanOpencodeCommands(projectPath, homeDir);
        const count = Object.keys(opencodeCommands).length;
        if (count === 0) {
          logClient('debug', '[Vicoa] [subprogress] No slash commands to sync');
          return;
        }

        await vicoaClient.syncCommands(OPENCODE_SLASH_AGENT_TYPE, opencodeCommands);
        logClient('info', `[Vicoa] Synced ${count} OpenCode slash commands`);
      } catch (error) {
        logClient('warn', `[Vicoa] Failed to sync OpenCode slash commands: ${error}`);
      }
    })();
  }, 0);
}

export const VicoaPlugin: Plugin = async (context) => {
  const { client, directory } = context;

  // Get API key from environment or credentials file
  const apiKey = getApiKey();
  const baseUrl = process.env.VICOA_API_URL || process.env.VICOA_BASE_URL || 'https://agents.vicoa.ai';

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

    // Format project path to use ~ for the home directory.
    const formattedProjectPath = formatProjectPath(projectPath);

    // Link the session to the local machine so the app can route file/git RPCs
    // (list-files, git-diff, git-status) to its daemon — without this the app's
    // "files and changes" view has no machine to address and comes back empty.
    // Read from the daemon state file; null when no daemon is registered here,
    // in which case there is nothing to serve those RPCs anyway.
    const machineId = readMachineId(baseUrl);
    if (machineId) {
      log(client, 'info', `[Vicoa] Linking session to machine ${machineId}`);
    } else {
      log(client, 'debug', '[Vicoa] No local daemon machine_id; session will be unlinked (files/changes unavailable)');
    }

    await vicoaClient.registerAgentInstance(formattedProjectPath, homeDir, machineId);
    log(client, "info", `[Vicoa] Registered session: ${agentInstanceId}`);

    // No synthetic "OpenCode session started, waiting for your input..."
    // message: the user just launched the TUI themselves and is sitting in
    // front of it, so a placeholder agent row only clutters the chat list.
    //
    // That message did carry a side effect worth naming, since nothing else
    // replaces it: posting an agent message advances the instance's
    // last_read_message_id server-side, which is the cursor the catch-up fetch
    // falls back to when the client has no watermark of its own. Sending it on
    // every launch therefore discarded any backlog. Without it, a session
    // resumed onto the same instance id (reused via VICOA_AGENT_INSTANCE_ID)
    // now replays the user messages sent while it was gone — the reason the WS
    // client delivers them one at a time.
    startCommandSyncSubprogress(vicoaClient, projectPath, homeDir, (level, message) =>
      log(client, level, message)
    );
  } catch (error) {
    log(client, "error", `[Vicoa] Failed to register: ${error}`);
    return {};
  }

  // Receive user messages over the session-scoped WebSocket. URL is derived
  // from the REST base_url unless VICOA_WS_URL overrides it.
  const wsUrl = process.env.VICOA_WS_URL || deriveWsUrl(baseUrl);
  const sessionWsClient = new SessionMessagesWsClient({
    wsUrl,
    apiKey,
    instanceId: agentInstanceId,
    cliVersion: PLUGIN_VERSION,
    log: (level: string, msg: string) =>
      log(client, (level as 'debug' | 'info' | 'warn' | 'error') || 'info', `[Vicoa] ${msg}`),
    onAuthFailure: (reason) => {
      // The client has stopped and will not reconnect: the credential is gone,
      // not flaky. Say so once — the dashboard link is dead for this session
      // and re-authenticating means restarting OpenCode.
      log(client, 'error',
        `[Vicoa] Dashboard connection closed — credential rejected (${reason}). ` +
        'Re-authenticate with "vicoa --auth" and restart OpenCode.');
    },
    onUserMessage: async (userMessage) => {
      log(client, "info", `[Vicoa] Received message from dashboard: ${userMessage.substring(0, 80)}${userMessage.length > 80 ? '...' : ''}`);

      // Check if it's a control command
      if (
        await handleControlCommand(userMessage, {
          client,
          vicoaClient,
          currentSessionId,
          currentSessionStatus,
          getTuiCurrentAgent: () => tuiCurrentAgent,
          setTuiCurrentAgent: (agent) => {
            tuiCurrentAgent = agent;
          },
          setPreferredAgent: (agent) => {
            preferredAgent = agent;
          },
          setTuiCurrentModel: (model) => {
            currentTuiModel = model;
          },
        })
      ) {
        await settleAfterUserAction(vicoaClient);
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
        // After processing a slash command, settle back to AWAITING_INPUT.
        // If the command kicked off real work, the session.status:busy that
        // follows re-arms the normal turn-end handling.
        await settleAfterUserAction(vicoaClient);
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
  });

  sessionWsClient.start();

  // ── session finalization ────────────────────────────────────────────────
  // Mark the instance COMPLETED and tear down the WebSocket exactly once, no
  // matter which shutdown path fires first. OpenCode can end a session several
  // ways and they do not all reach the plugin the same way:
  //   - the `dispose` plugin hook and the `*.disposed` events cover a graceful
  //     exit (/exit, the app quitting),
  //   - but a signal (Ctrl+C = SIGINT, `kill` = SIGTERM) tears the process down
  //     without delivering either, which is why the status used to stay ACTIVE
  //     after Ctrl+C. The process handlers below are the backstop for that.
  // endSession is idempotent server-side, so racing paths are safe.
  //
  // Cap the shutdown wait so a stalled backend can't make Ctrl+C hang.
  // endSession is best-effort: if the write can't land in this window, exit
  // anyway rather than block the user.
  const SHUTDOWN_FINALIZE_TIMEOUT_MS = 3000;
  let finalized = false;
  async function finalizeSession(reason: string): Promise<void> {
    if (finalized) return;
    finalized = true;
    log(client, 'info', `[Vicoa] Finalizing session (${reason})`);
    sessionWsClient.stop();
    try {
      await Promise.race([
        vicoaClient.endSession(),
        new Promise<void>((resolve) => setTimeout(resolve, SHUTDOWN_FINALIZE_TIMEOUT_MS)),
      ]);
    } catch (error) {
      log(client, 'warn', `[Vicoa] endSession during ${reason} failed: ${error}`);
    }
  }

  // Signal backstop for the Ctrl+C / kill path. The plugin runs inside the
  // OpenCode process, so these handlers are additive to OpenCode's own — Node
  // runs every listener. We do NOT call process.exit(): OpenCode owns the exit,
  // and forcing it here would cut off its own teardown. We only fire the
  // COMPLETED write and let the normal exit proceed. Adding a listener does
  // suppress Node's default "exit immediately on signal", but OpenCode installs
  // its own signal handling that drives the real shutdown, so the process still
  // exits; endSession is a sub-second REST call with its own timeout, so it
  // does not meaningfully delay it.
  const onSignal = (signal: NodeJS.Signals) => {
    void finalizeSession(signal);
  };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);
  process.once('SIGHUP', onSignal);
  // `beforeExit` fires on a natural event-loop drain (not on signals or
  // process.exit), a final safety net if the process winds down without any of
  // the above. It can run async work, unlike `exit`.
  process.once('beforeExit', () => {
    void finalizeSession('beforeExit');
  });

  return {
    dispose: async () => {
      await finalizeSession('dispose');
    },
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

            // User messages carry the agent and model the TUI used — track
            // both so we can PATCH session_config on terminal-side changes
            // (keybind cycles, /agent, model picker, etc.) without waiting
            // for the app to send a control command.
            if (message.role === 'user') {
              // Agent/mode tracking
              if ((message as any).agent) {
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
                  void vicoaClient.patchSessionConfig({ agent: 'opencode', opencode_mode: reportedAgent });
                }
              }

              // Model tracking — UserMessage.model = { providerID, modelID }
              const msgModel = (message as any).model as { providerID?: string; modelID?: string } | undefined;
              if (msgModel?.providerID && msgModel?.modelID) {
                const modelSlug = `${msgModel.providerID}/${msgModel.modelID}`;
                if (modelSlug !== currentTuiModel) {
                  currentTuiModel = modelSlug;
                  void vicoaClient.patchSessionConfig({ agent: 'opencode', model: modelSlug });
                  log(client, 'info', `[Vicoa] TUI model synced to session_config: ${modelSlug}`);
                }
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

            // A `task` subagent gets its own child session. Record it so its
            // idle/status events can be told apart later, and leave the
            // instance's own session tracking alone.
            if (session.parentID) {
              childSessionIds.add(session.id);
              log(client, 'debug', `[Vicoa] Child session created: ${session.id} (parent ${session.parentID})`);
              return;
            }

            lastSessionTitle = session.title;
            currentSessionId = session.id;
            log(client, 'info', `[Vicoa] Session created: ${session.id}`);

            await markActive(vicoaClient);
            return;
          }

          case 'session.updated': {
            const session = event.properties.info;
            // Subagent sessions get their own titles — not the instance's name.
            if (session.parentID) return;

            const nextTitle = session.title;
            if (nextTitle && nextTitle !== lastSessionTitle) {
              lastSessionTitle = nextTitle;
              await vicoaClient.updateAgentInstanceName(nextTitle);
              log(client, 'info', `[Vicoa] Updated session title: ${nextTitle}`);
            }
            return;
          }

          case 'session.deleted': {
            const session = event.properties.info;
            // A finished subagent's session being cleaned up must not end the
            // whole Vicoa session — endSession() is terminal and fires the
            // terminate NOTIFY.
            if (session.parentID || childSessionIds.has(session.id)) {
              childSessionIds.delete(session.id);
              return;
            }

            currentSessionId = undefined;
            await vicoaClient.endSession();
            return;
          }

          case 'session.idle': {
            const { sessionID } = event.properties;
            if (isChildSession(sessionID)) {
              log(client, 'debug', `[Vicoa] Ignoring idle from child session ${sessionID}`);
              return;
            }

            log(client, 'info', '[Vicoa] Session idle');
            await settleAwaitingInput(vicoaClient);
            return;
          }

          case 'session.status': {
            const { sessionID, status } = event.properties;
            // A subagent going busy/idle says nothing about whether the user's
            // session needs them.
            if (isChildSession(sessionID)) return;

            const statusType = status.type;

            // Track current status for interrupt handling
            currentSessionStatus = statusType;

            if (statusType === 'busy' || statusType === 'retry') {
              await markActive(vicoaClient);
            } else if (statusType === 'idle') {
              // Whichever of this and session.idle lands first settles the
              // turn; the other is a no-op.
              await settleAwaitingInput(vicoaClient);
            }
            return;
          }

          case 'session.error': {
            // A subagent's error is the main session's problem to report (or
            // recover from) — it must not settle the instance while the main
            // session is still working.
            if (isChildSession(event.properties.sessionID)) return;

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
          // The graceful-exit events (/exit, app quitting). Signal-based
          // teardown (Ctrl+C) does not emit these — the process signal
          // handlers above cover that. finalizeSession dedupes across them.
          case 'server.instance.disposed' as string:
          case 'global.disposed' as string: {
            await finalizeSession(event.type);
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
