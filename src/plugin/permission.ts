import type { Permission } from '@opencode-ai/sdk';

/**
 * Permission option for user selection
 */
export type PermissionOption = { label: string; response: 'once' | 'always' | 'reject' };

/**
 * Default options shown when the permission metadata doesn't supply its own.
 * Mirrors the three choices Claude Code's own TUI presents.
 */
export const DEFAULT_PERMISSION_OPTIONS: PermissionOption[] = [
  { label: 'Allow', response: 'once' },
  { label: 'Allow always', response: 'always' },
  { label: 'Reject', response: 'reject' },
];

/**
 * Build the option list for a permission request. If the permission's
 * metadata includes an `options` array we use those labels (mapped to the
 * standard responses in order); otherwise fall back to the defaults.
 */
export function buildPermissionOptions(permission: Permission): PermissionOption[] {
  const meta = permission.metadata as Record<string, unknown> | undefined;
  const metaOptions = meta?.options;

  // If metadata supplies an options array, use those labels but keep standard responses
  if (Array.isArray(metaOptions) && metaOptions.length > 0) {
    const responses: Array<'once' | 'always' | 'reject'> = ['once', 'always', 'reject'];
    return metaOptions.slice(0, 3).map((label, i) => ({
      label: String(label),
      response: responses[i] ?? 'reject',
    }));
  }

  return DEFAULT_PERMISSION_OPTIONS;
}

/**
 * Format a permission request for display in Vicoa UI.
 * Shows the permission type, patterns, and code diff/preview if available.
 */
export function formatPermissionRequest(permission: Permission, options: PermissionOption[]): string {
  // Handle both V1 (type/pattern) and V2 (permission/patterns) SDK structures
  const permissionType = (permission as any).permission || permission.type || 'unknown';

  // Extract patterns from either V1 (pattern) or V2 (patterns) format
  let patterns: string[] = [];
  if ((permission as any).patterns) {
    patterns = (permission as any).patterns;
  } else if (permission.pattern) {
    patterns = Array.isArray(permission.pattern) ? permission.pattern : [permission.pattern];
  }

  // Format as: **Type** (`pattern`) - consistent with tool use format
  let message = '**Permission Required**\n\n';

  if (patterns.length === 0) {
    message += `**${permissionType}**`;
  } else if (patterns.length === 1) {
    message += `**${permissionType}** (\`${patterns[0]}\`)`;
  } else {
    message += `**${permissionType}** (${patterns.length} patterns)\n`;
    patterns.forEach(p => {
      message += `  • \`${p}\`\n`;
    });
  }

  // Add code diff or content preview if available in metadata
  const meta = permission.metadata as Record<string, unknown> | undefined;
  if (meta?.input && typeof meta.input === 'object') {
    const input = meta.input as Record<string, unknown>;

    // For Edit tool - show diff
    if (permissionType === 'edit' && input.old_string && input.new_string) {
      const oldStr = String(input.old_string);
      const newStr = String(input.new_string);
      message += '\n```diff\n';

      // Simple diff: show removed and added lines
      for (const line of oldStr.split('\n')) {
        message += `- ${line}\n`;
      }
      for (const line of newStr.split('\n')) {
        message += `+ ${line}\n`;
      }
      message += '```';
    }

    // For Write tool - show content preview
    else if (permissionType === 'write' && input.content) {
      const content = String(input.content);
      const preview = content.length > 500 ? content.slice(0, 500) + '...' : content;
      message += '\n```\n' + preview + '\n```';
    }

    // For Bash tool - show command
    else if (permissionType === 'bash' && input.command) {
      message += '\n```bash\n' + input.command + '\n```';
    }
  }

  // Add additional context from metadata if available
  if (meta?.description && typeof meta.description === 'string') {
    message += `\n\n${meta.description}`;
  }

  // Format options in the same [OPTIONS] envelope the Python wrapper uses,
  // so the Vicoa UI renders them as actionable buttons/choices.
  const optionLines = options.map((opt, i) => `${i + 1}. ${opt.label}`);
  message += `\n\n[OPTIONS]\n${optionLines.join('\n')}\n[/OPTIONS]`;

  return message;
}

/**
 * Given a user reply string (from the Vicoa poller) and the options that were
 * sent for that permission, return the matching OpenCode permission response
 * value, or null if it doesn't match.
 */
export function parsePermissionReply(
  userReply: string,
  options: PermissionOption[]
): 'once' | 'always' | 'reject' | null {
  const trimmed = userReply.trim().toLowerCase();

  // Try direct label match (case-insensitive)
  for (const opt of options) {
    if (opt.label.toLowerCase() === trimmed) {
      return opt.response;
    }
  }

  // Try numeric match (1, 2, 3)
  const num = Number.parseInt(trimmed, 10);
  if (!Number.isNaN(num) && num >= 1 && num <= options.length) {
    return options[num - 1].response;
  }

  // Fallback: look for keywords
  if (/^(allow|yes|y|ok|approve|1)$/i.test(trimmed)) {
    return 'once';
  }
  if (/^(always|forever|permanent|2)$/i.test(trimmed)) {
    return 'always';
  }
  if (/^(reject|no|n|deny|cancel|3)$/i.test(trimmed)) {
    return 'reject';
  }

  return null;
}
