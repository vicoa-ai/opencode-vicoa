import type { FilePart, PatchPart, ReasoningPart, ToolPart } from '@opencode-ai/sdk';

const LANGUAGE_MAP: Record<string, string> = {
  py: 'python',
  js: 'javascript',
  ts: 'typescript',
  jsx: 'jsx',
  tsx: 'tsx',
  java: 'java',
  cpp: 'cpp',
  c: 'c',
  cs: 'csharp',
  rb: 'ruby',
  go: 'go',
  rs: 'rust',
  php: 'php',
  swift: 'swift',
  kt: 'kotlin',
  yaml: 'yaml',
  yml: 'yaml',
  json: 'json',
  xml: 'xml',
  html: 'html',
  css: 'css',
  scss: 'scss',
  sql: 'sql',
  sh: 'bash',
  bash: 'bash',
  md: 'markdown',
  txt: 'text',
};

type ToolInput = Record<string, unknown>;

function truncateText(text: string, maxLength = 100): string {
  if (text.length <= maxLength) {
    return text;
  }
  return `${text.slice(0, maxLength)}...`;
}

function detectLanguage(filePath: string): string {
  const extension = filePath.includes('.') ? filePath.split('.').pop() ?? '' : '';
  return LANGUAGE_MAP[extension] ?? '';
}

function getString(input: ToolInput, keys: string[], fallback = ''): string {
  for (const key of keys) {
    const value = input[key];
    if (typeof value === 'string') {
      return value;
    }
  }
  return fallback;
}

function getBoolean(input: ToolInput, keys: string[], fallback = false): boolean {
  for (const key of keys) {
    const value = input[key];
    if (typeof value === 'boolean') {
      return value;
    }
  }
  return fallback;
}

function getArray<T>(input: ToolInput, keys: string[]): T[] {
  for (const key of keys) {
    const value = input[key];
    if (Array.isArray(value)) {
      return value as T[];
    }
  }
  return [];
}

function formatDiffBlock(oldText: string, newText: string): string[] {
  const diffLines: string[] = ['```diff'];

  if (!oldText && newText) {
    for (const line of newText.split('\n')) {
      diffLines.push(`+ ${line}`);
    }
  } else if (oldText && !newText) {
    for (const line of oldText.split('\n')) {
      diffLines.push(`- ${line}`);
    }
  } else {
    const oldLines = oldText.split('\n');
    const newLines = newText.split('\n');

    const commonPrefix: string[] = [];
    const commonSuffix: string[] = [];

    for (let i = 0; i < Math.min(oldLines.length, newLines.length); i += 1) {
      if (oldLines[i] === newLines[i]) {
        commonPrefix.push(oldLines[i]);
      } else {
        break;
      }
    }

    const oldRemaining = oldLines.slice(commonPrefix.length);
    const newRemaining = newLines.slice(commonPrefix.length);

    if (oldRemaining.length && newRemaining.length) {
      for (let i = 1; i <= Math.min(oldRemaining.length, newRemaining.length); i += 1) {
        if (oldRemaining[oldRemaining.length - i] === newRemaining[newRemaining.length - i]) {
          commonSuffix.unshift(oldRemaining[oldRemaining.length - i]);
        } else {
          break;
        }
      }
    }

    const changedOld = commonSuffix.length
      ? oldRemaining.slice(0, oldRemaining.length - commonSuffix.length)
      : oldRemaining;
    const changedNew = commonSuffix.length
      ? newRemaining.slice(0, newRemaining.length - commonSuffix.length)
      : newRemaining;

    if ((commonPrefix.length || commonSuffix.length) && (changedOld.length || changedNew.length)) {
      const contextBefore = commonPrefix.slice(-2);
      const contextAfter = commonSuffix.slice(0, 2);

      for (const line of contextBefore) {
        diffLines.push(`  ${line}`);
      }
      for (const line of changedOld) {
        diffLines.push(`- ${line}`);
      }
      for (const line of changedNew) {
        diffLines.push(`+ ${line}`);
      }
      for (const line of contextAfter) {
        diffLines.push(`  ${line}`);
      }
    } else {
      for (const line of oldLines) {
        diffLines.push(`- ${line}`);
      }
      for (const line of newLines) {
        diffLines.push(`+ ${line}`);
      }
    }
  }

  diffLines.push('```');
  return diffLines;
}

export function formatToolUsage(toolName: string, inputData: ToolInput): string {
  if (toolName.startsWith('mcp__vicoa__')) {
    return `Using tool: ${toolName}`;
  }

  const normalizedTool = toolName.toLowerCase();

  if (normalizedTool === 'write') {
    const filePath = getString(inputData, ['file_path', 'filePath', 'path', 'filename'], 'unknown');
    const content = getString(inputData, ['content', 'text', 'value']);
    const lang = detectLanguage(filePath);

    return [`Using tool: Write - \`${filePath}\``, `\`\`\`${lang}`, content, '```']
      .filter((line) => line.length > 0)
      .join('\n');
  }

  if (normalizedTool === 'read' || normalizedTool === 'notebookread' || normalizedTool === 'notebookedit') {
    const filePath = getString(inputData, ['file_path', 'filePath', 'path', 'notebook_path'], 'unknown');
    return `Using tool: ${toolName} - \`${filePath}\``;
  }

  if (normalizedTool === 'edit') {
    const filePath = getString(inputData, ['file_path', 'filePath', 'path'], 'unknown');
    const oldString = getString(inputData, ['old_string', 'oldString']);
    const newString = getString(inputData, ['new_string', 'newString']);
    const replaceAll = getBoolean(inputData, ['replace_all', 'replaceAll']);

    const diffLines = [`Using tool: **Edit** - \`${filePath}\``];
    if (replaceAll) {
      diffLines.push('*Replacing all occurrences*');
    }
    diffLines.push('');
    diffLines.push(...formatDiffBlock(oldString, newString));
    return diffLines.join('\n');
  }

  if (normalizedTool === 'multiedit') {
    const filePath = getString(inputData, ['file_path', 'filePath', 'path'], 'unknown');
    const edits = getArray<Record<string, unknown>>(inputData, ['edits']);
    const lines = [
      `Using tool: **MultiEdit** - \`${filePath}\``,
      `*Making ${edits.length} edit${edits.length === 1 ? '' : 's'}:*`,
      '',
    ];

    edits.forEach((edit, index) => {
      const editIndex = index + 1;
      const oldString = typeof edit.old_string === 'string' ? edit.old_string : (edit.oldString as string) ?? '';
      const newString = typeof edit.new_string === 'string' ? edit.new_string : (edit.newString as string) ?? '';
      const replaceAll = Boolean(edit.replace_all ?? edit.replaceAll ?? false);

      lines.push(replaceAll ? `### Edit ${editIndex} *(replacing all occurrences)*` : `### Edit ${editIndex}`);
      lines.push('');
      lines.push(...formatDiffBlock(oldString, newString));
      lines.push('');
    });

    return lines.join('\n');
  }

  if (normalizedTool === 'bash') {
    const command = getString(inputData, ['command', 'cmd']);
    return `Using tool: Bash - \`${command}\``;
  }

  if (normalizedTool === 'grep' || normalizedTool === 'glob') {
    const pattern = getString(inputData, ['pattern', 'query'], 'unknown');
    const path = getString(inputData, ['path', 'directory'], 'current directory');
    return `Using tool: ${toolName} - \`${truncateText(pattern, 50)}\` in ${path}`;
  }

  if (normalizedTool === 'list' || normalizedTool === 'ls') {
    const path = getString(inputData, ['path'], 'unknown');
    return `Using tool: list - \`${path}\``;
  }

  if (normalizedTool === 'patch') {
    const file = getString(inputData, ['file', 'path'], 'unknown');
    return `Using tool: patch - \`${file}\``;
  }

  if (normalizedTool === 'skill') {
    const name = getString(inputData, ['name', 'skill'], 'unknown');
    return `Using tool: skill - \`${name}\``;
  }

  if (normalizedTool === 'question') {
    const text = getString(inputData, ['text', 'question', 'message'], '');
    return text ? `Asking: ${truncateText(text, 100)}` : 'Using tool: question';
  }

  if (normalizedTool === 'lsp') {
    const command = getString(inputData, ['command', 'method'], 'unknown');
    const file = getString(inputData, ['file', 'path'], '');
    return file ? `Using tool: lsp - ${command} on \`${file}\`` : `Using tool: lsp - ${command}`;
  }

  if (normalizedTool === 'todowrite') {
    const todos = getArray<Record<string, unknown>>(inputData, ['todos']);
    if (!todos.length) {
      return 'Using tool: TodoWrite - clearing todo list';
    }

    const statusSymbol: Record<string, string> = {
      pending: '○',
      in_progress: '◐',
      completed: '●',
    };

    const lines = ['Using tool: TodoWrite - Todo List', ''];
    for (const todo of todos) {
      const status = typeof todo.status === 'string' ? todo.status : 'pending';
      const content = typeof todo.content === 'string' ? todo.content : '';
      const symbol = statusSymbol[status] ?? '•';
      lines.push(`${symbol} ${truncateText(content, 100)}`);
    }
    return lines.join('\n');
  }

  if (normalizedTool === 'todoread') {
    return 'Using tool: todoread';
  }

  if (normalizedTool === 'task') {
    const description = getString(inputData, ['description'], 'unknown task');
    const subagentType = getString(inputData, ['subagent_type', 'subagentType', 'agent'], 'unknown');
    return `Using tool: Task - ${truncateText(description, 50)} (agent: ${subagentType})`;
  }

  if (normalizedTool === 'webfetch') {
    const url = getString(inputData, ['url'], 'unknown');
    return `Using tool: WebFetch - \`${truncateText(url, 80)}\``;
  }

  if (normalizedTool === 'websearch') {
    const query = getString(inputData, ['query'], 'unknown');
    return `Using tool: WebSearch - ${truncateText(query, 80)}`;
  }

  if (toolName === 'ListMcpResourcesTool') {
    return 'Using tool: List MCP Resources';
  }

  const defaultKeys = ['file', 'path', 'query', 'content', 'message', 'description', 'name'];
  for (const key of defaultKeys) {
    if (typeof inputData[key] === 'string') {
      return `Using tool: ${toolName} - ${truncateText(String(inputData[key]), 50)}`;
    }
  }

  return `Using tool: ${toolName}`;
}

// Most tool outputs don't need truncation - show them in full.
// Only truncate for tools that tend to produce very large/noisy output.
const TRUNCATE_OUTPUT_TOOLS = new Set(['']);  // set to empty for not to filter message now.
const TRUNCATE_LIMIT = 500;

export function formatToolResult(output: string, toolName?: string): string {
  try {
    const parsed = JSON.parse(output);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const keys = Object.keys(parsed).slice(0, 3);
      const summary = `JSON object with keys: ${keys.join(', ')}`;
      return keys.length < Object.keys(parsed).length ? `${summary} and ${Object.keys(parsed).length - keys.length} more` : summary;
    }
  } catch {
    // not JSON
  }

  // Default: don't truncate tool output unless it's in the truncate list
  if (toolName && TRUNCATE_OUTPUT_TOOLS.has(toolName.toLowerCase())) {
    return truncateText(output, TRUNCATE_LIMIT);
  }

  return output;
}

// Tools whose Result line is noise: either raw file/list content (read-side)
// or a boilerplate success confirmation like "Edit applied successfully."
// (write-side).  Only the usage line is shown for these.
const SUPPRESS_OUTPUT_TOOLS = new Set([
  'read', 'notebookread', 'list', 'ls', 'glob', 'grep', 'todoread', 'lsp',
  'write', 'edit', 'multiedit', 'patch', 'notebookedit', 'todowrite',
]);

export function shouldSuppressToolOutput(toolName: string): boolean {
  return SUPPRESS_OUTPUT_TOOLS.has(toolName.toLowerCase());
}

export function formatToolPart(toolPart: ToolPart): string {
  const base = formatToolUsage(toolPart.tool, toolPart.state.input ?? {});

  if (toolPart.state.status === 'completed') {
    if (shouldSuppressToolOutput(toolPart.tool)) {
      return base;
    }
    const result = toolPart.state.output ? formatToolResult(toolPart.state.output, toolPart.tool) : '[empty]';
    // Filter out empty results - just show the tool usage
    if (result === '[empty]') {
      return base;
    }
    return `${base}\nResult: ${result}`;
  }

  if (toolPart.state.status === 'error') {
    const error = toolPart.state.error ? truncateText(toolPart.state.error, 200) : 'Unknown error';
    return `${base}\n${error}`;
  }

  return base;
}

export function formatReasoningPart(part: ReasoningPart): string {
  if (!part.text) {
    return '';
  }
  return `[Thinking: ${truncateText(part.text, 200)}]`;
}

export function formatFilePart(part: FilePart): string {
  if (part.mime?.startsWith('image/') && part.url) {
    const altText = part.filename ?? 'image';
    return `![${altText}](${part.url})`;
  }

  const source = part.source?.text?.value ?? '';
  const path = part.source?.path ?? part.filename ?? part.url ?? 'file';
  if (source) {
    const lang = detectLanguage(path);
    return [`File: \`${path}\``, `\`\`\`${lang}`, source, '```'].join('\n');
  }

  return `File: \`${path}\``;
}

export function formatPatchPart(part: PatchPart): string {
  if (part.files?.length) {
    return `Patch updated: ${part.files.join(', ')}`;
  }
  return 'Patch updated';
}
