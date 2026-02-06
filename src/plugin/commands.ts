import path from 'path';
import * as fs from 'fs/promises';
import type { VicoaClient } from './vicoa-client.js';
import { log } from './utils.js';

export const OPENCODE_SLASH_AGENT_TYPE = 'opencode';

export const OPENCODE_SLASH_COMMAND_ACTIONS: Record<string, string> = {
  sessions: 'session.list',
  resume: 'session.list',
  continue: 'session.list',
  new: 'session.new',
  clear: 'session.new',
  models: 'model.list',
  agents: 'agent.list',
  mcps: 'mcp.list',
  connect: 'provider.connect',
  status: 'opencode.status',
  themes: 'theme.switch',
  help: 'help.show',
  exit: 'app.exit',
  quit: 'app.exit',
  q: 'app.exit',
  editor: 'prompt.editor',
  share: 'session.share',
  rename: 'session.rename',
  timeline: 'session.timeline',
  fork: 'session.fork',
  compact: 'session.compact',
  summarize: 'session.compact',
  unshare: 'session.unshare',
  undo: 'session.undo',
  redo: 'session.redo',
  timestamps: 'session.toggle.timestamps',
  'toggle-timestamps': 'session.toggle.timestamps',
  thinking: 'session.toggle.thinking',
  'toggle-thinking': 'session.toggle.thinking',
  copy: 'session.copy',
  export: 'session.export',
};

export const OPENCODE_EXECUTE_COMMAND_KEYS: Record<string, string> = {
  'session.new': 'session_new',
  'session.share': 'session_share',
  'session.interrupt': 'session_interrupt',
  'session.compact': 'session_compact',
  'session.page.up': 'messages_page_up',
  'session.page.down': 'messages_page_down',
  'session.line.up': 'messages_line_up',
  'session.line.down': 'messages_line_down',
  'session.half.page.up': 'messages_half_page_up',
  'session.half.page.down': 'messages_half_page_down',
  'session.first': 'messages_first',
  'session.last': 'messages_last',
  'agent.cycle': 'agent_cycle',
};

/**
 * Execute a TUI command via the OpenCode client.
 */
export async function executeTuiCommand(client: any, command: string): Promise<void> {
  const executeKey = OPENCODE_EXECUTE_COMMAND_KEYS[command];
  if (executeKey) {
    await client.tui.executeCommand({ body: { command: executeKey } });
    return;
  }

  await client.tui.publish({
    body: {
      type: 'tui.command.execute',
      properties: { command },
    },
  });
}

export type OpencodeCommandMap = Record<string, { description: string }>;

export type ParsedSlashCommand = {
  name: string;
  rawName: string;
  arguments: string;
};

export function parseSlashCommand(input: string): ParsedSlashCommand | null {
  const trimmed = input.trim();
  if (!trimmed.startsWith('/')) {
    return null;
  }

  const body = trimmed.slice(1).trim();
  if (!body) {
    return null;
  }

  const [rawName, ...rest] = body.split(/\s+/);
  if (!rawName) {
    return null;
  }

  return {
    rawName,
    name: rawName.toLowerCase(),
    arguments: rest.join(' ').trim(),
  };
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await fs.stat(target);
    return true;
  } catch {
    return false;
  }
}

async function walkMarkdownFiles(root: string): Promise<string[]> {
  const results: string[] = [];
  if (!(await pathExists(root))) {
    return results;
  }

  const entries = await fs.readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      results.push(...(await walkMarkdownFiles(fullPath)));
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) {
      results.push(fullPath);
    }
  }

  return results;
}

function getOpencodeCommandRoots(projectDir: string | undefined, homeDir: string): string[] {
  const roots = new Set<string>();

  if (process.env.OPENCODE_CONFIG_DIR) {
    roots.add(process.env.OPENCODE_CONFIG_DIR);
  }
  if (process.env.XDG_CONFIG_HOME) {
    roots.add(path.join(process.env.XDG_CONFIG_HOME, 'opencode'));
  }

  roots.add(path.join(homeDir, '.config', 'opencode'));
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA || path.join(homeDir, 'AppData', 'Roaming');
    roots.add(path.join(appData, 'opencode'));
  }

  // ~/.opencode fallback (all platforms).
  roots.add(path.join(homeDir, '.opencode'));

  // Per-project override.
  if (projectDir) {
    roots.add(path.join(projectDir, '.opencode'));
  }

  return Array.from(roots);
}

function parseCommandDescription(content: string, fallbackName: string): string {
  const lines = content.split('\n');
  let description = '';

  if (lines.length > 0 && lines[0].trim() === '---') {
    for (let i = 1; i < lines.length; i += 1) {
      const line = lines[i].trim();
      if (line === '---') {
        break;
      }
      const [key, value] = line.split(':', 2).map((item) => item?.trim());
      if (key?.toLowerCase() === 'description' && value) {
        description = value.replace(/^['"]|['"]$/g, '').trim();
        break;
      }
    }
  }

  if (!description) {
    for (const line of lines) {
      const stripped = line.trim();
      if (!stripped) {
        continue;
      }
      description = stripped.startsWith('#') ? stripped.replace(/^#+/, '').trim() : stripped;
      break;
    }
  }

  return description || `Custom command: ${fallbackName}`;
}

export async function scanOpencodeCommands(
  projectDir: string | undefined,
  homeDir: string
): Promise<OpencodeCommandMap> {
  const commands: OpencodeCommandMap = {};
  const roots = getOpencodeCommandRoots(projectDir, homeDir);

  for (const root of roots) {
    const commandRoot = path.join(root, 'commands');
    const files = await walkMarkdownFiles(commandRoot);
    for (const filePath of files) {
      const relativePath = path.relative(commandRoot, filePath);
      const normalized = relativePath.split(path.sep).join('/');
      const commandName = normalized.replace(/\.md$/i, '');
      if (!commandName) {
        continue;
      }

      try {
        const content = await fs.readFile(filePath, 'utf-8');
        const description = parseCommandDescription(content, commandName);
        commands[commandName] = { description };
      } catch {
        continue;
      }
    }
  }

  return commands;
}

/**
 * Handle slash command execution. Returns true if the command was executed
 * directly (built-in with no arguments), false if it should be submitted as
 * a prompt (built-in with args, custom command, or unknown command).
 */
export async function handleSlashCommand(
  userMessage: string,
  client: any,
  currentSessionId?: string,
  vicoaClient?: VicoaClient
): Promise<boolean> {
  const parsed = parseSlashCommand(userMessage);
  if (!parsed) {
    return false;
  }

  const action = OPENCODE_SLASH_COMMAND_ACTIONS[parsed.name];

  // Built-in command with no arguments — use the direct TUI action shortcut.
  if (action && !parsed.arguments) {
    // Special handling for /share command: call the API directly to get the URL
    if (parsed.name === 'share' && currentSessionId && vicoaClient) {
      try {
        const { data: session } = await client.session.share({
          path: { id: currentSessionId },
        });

        if (session?.share?.url) {
          await vicoaClient.sendMessage(`Share url: ${session.share.url}`);
          log(client, 'info', `[Vicoa] Shared session and sent URL to UI: ${session.share.url}`);
        } else {
          log(client, 'warn', '[Vicoa] Session shared but no URL in response');
        }
        return true;
      } catch (error) {
        log(client, 'warn', `[Vicoa] Failed to share session: ${error}`);
        // Fall back to TUI command if API call fails
      }
    }

    await executeTuiCommand(client, action);
    log(client, 'info', `[Vicoa] Executed slash command: /${parsed.rawName}`);
    return true;
  }

  // Built-in with arguments, or a custom command — fall through so the raw
  // slash command text is submitted as a prompt (OpenCode parses args natively).
  return false;
}
