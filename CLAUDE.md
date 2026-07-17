# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This is an OpenCode plugin that integrates with Vicoa (a mobile/web platform for managing AI coding agents). The plugin enables bidirectional communication between OpenCode sessions and the Vicoa dashboard, allowing users to monitor OpenCode progress, send messages, approve permissions, and execute commands from their phone or browser.

**Key Architecture**: This plugin runs INSIDE OpenCode (not as a separate wrapper) and directly calls Vicoa REST APIs. It eliminates the need for a separate external wrapper process by implementing everything in TypeScript.

## Development Commands

```bash
# Build the plugin (compiles TypeScript to dist/)
npm run build

# Development mode with auto-rebuild
npm run dev

# Type checking without emitting files
npm run type-check

# Clean build artifacts
npm run clean
```

## Testing the Plugin Locally

To test local changes with OpenCode:

1. Build the plugin: `npm run build`
2. Add to OpenCode config (`~/.config/opencode/config.json`):
   ```json
   {
     "$schema": "https://opencode.ai/config.json",
     "plugins": ["file:///absolute/path/to/opencode-vicoa/dist/index.js"]
   }
   ```
3. Set Vicoa API key: `export VICOA_API_KEY="your-key"` or authenticate with `vicoa --auth`
4. Run OpenCode to test

## Architecture

### Core Components

The plugin is organized into focused modules in `src/plugin/`:

- **vicoa-client.ts**: HTTP client for Vicoa REST APIs (register agent, send messages, sync commands, update status)
- **session-ws-client.ts**: Session-scoped WebSocket to `/ws` delivering user messages from the dashboard. Replaced the 1 Hz REST poller
- **commands.ts**: Handles slash commands from Vicoa (maps user commands like `/sessions` to OpenCode TUI actions)
- **control.ts**: Processes control commands (interrupt, agent switching) sent from Vicoa dashboard
- **permission.ts**: Formats permission requests for Vicoa UI and parses user responses back to OpenCode
- **credentials.ts**: Loads Vicoa API key from `~/.vicoa/credentials.json` or `VICOA_API_KEY` env var
- **format-utils.ts**: Formats OpenCode message parts (tool usage, files, reasoning) for Vicoa display
- **path-utils.ts**: Normalizes file paths (replaces home directory with `~`)
- **utils.ts**: Logging utilities

### Plugin Lifecycle

1. **Initialization**:
   - Loads Vicoa API key from credentials or environment
   - Registers agent instance with Vicoa backend
   - Syncs OpenCode slash commands to Vicoa dashboard
   - Connects the session WebSocket for bidirectional communication

2. **Event Handling**:
   - Listens to OpenCode SDK events (user messages, assistant messages, tool usage, permissions)
   - Forwards relevant events to Vicoa dashboard
   - Tracks message state incrementally to avoid duplicates
   - Handles permission requests by forwarding to Vicoa and waiting for user approval

3. **Message Flow**:
   - **OpenCode → Vicoa**: Assistant messages, tool usage, permission requests sent via `vicoaClient.sendMessage()` (REST)
   - **Vicoa → OpenCode**: User prompts arrive on the session WebSocket and are submitted to the TUI. Only this direction moved off REST
   - **Deduplication**: Tracks messages from UI (`messagesFromUI` buffer) to avoid echo loops

### Agent Instance Status

`instance.status` is the label the app shows: ACTIVE while a turn runs, AWAITING_INPUT once it returns. Two things make this easy to get wrong:

- **Writing a message is a status change.** `POST /messages/agent` sets the row to ACTIVE server-side (or AWAITING_INPUT when `requires_user_input`), and a user-message insert reactivates it. `VicoaClient` mirrors this in `knownStatus` so it can skip no-op writes without going stale.
- **`requires_user_input: true` fires push/email/SMS.** Use it only for genuine questions (e.g. permission requests). For acknowledging something the user just did from the app, post a plain message and set the status separately — see `settleAfterUserAction`.

Subagents (the `task` tool) get their own child sessions whose `session.idle` / `session.status` events look identical to the main session's. They are filtered via `childSessionIds`; without that, a subagent finishing parks the instance on AWAITING_INPUT mid-turn.

### Key State Management

The plugin maintains several critical state variables (src/index.ts:44-92):

- `currentSessionId`: Tracks active OpenCode session for interrupt/control commands
- `tuiCurrentAgent`: The agent the TUI currently displays (used for agent cycling)
- `preferredAgent`: User's requested agent (target for cycling)
- `messagesFromUI`: FIFO buffer (max 50) of messages originating from Vicoa to prevent echo
- `pendingPermissions`: Map of permission IDs waiting for user response from Vicoa
- `sentAssistantMessageIds`: Set tracking already-forwarded assistant messages to avoid duplicates
- `messagePartsById`: Accumulates incremental message part updates before sending to Vicoa

### Permission Flow

When OpenCode requests a permission (src/index.ts:59-69):
1. Plugin receives `permission.asked` event
2. Formats permission with code diff/preview using `formatPermissionRequest()`
3. Sends to Vicoa as a message with `requires_user_input: true`
4. Stores in `pendingPermissions` map with permission ID
5. When user responds from Vicoa, plugin calls `client.user.replyToPermission()` instead of forwarding as text
6. Removes from `pendingPermissions` after processing

### Agent Switching

The plugin supports switching OpenCode agents from the Vicoa dashboard (src/plugin/control.ts:16-51):
- Fetches list of primary agents from OpenCode
- Calculates number of `agent.cycle` commands needed to reach target agent
- Executes TUI commands to cycle to the desired agent
- Handles wraparound (TUI agent list is circular)

### Message Part Handling

OpenCode messages are composed of multiple "parts" (text, tool usage, files, reasoning). The plugin (src/index.ts:145-186):
- Accumulates parts incrementally using `messagePartsById` state
- Tool parts are sent immediately when they reach terminal state
- Text parts are accumulated with deltas and sent when message completes
- File parts only include images (source dumps are noise)
- Patch parts are internal and skipped
- Reasoning parts are formatted and included

### Tool Result Stripping

When users type `@filename` or `@folder` in OpenCode, the TUI auto-inserts Read/List tool results into the message. The plugin strips these (src/index.ts:188-216) to send only the user's actual prompt to Vicoa, avoiding clutter in the mobile UI.

## Publishing

The package is published to npm as `@vicoa/opencode`. Before publishing:
1. Update version in package.json
2. Run `npm run build` (happens automatically via `prepublishOnly` script)
3. Ensure `dist/` contains compiled JS and type definitions
4. The `files` field in package.json controls what gets published (only `dist/`)
