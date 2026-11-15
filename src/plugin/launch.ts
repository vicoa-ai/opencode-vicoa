/**
 * Whether this OpenCode process is one the user started themselves.
 *
 * OpenCode loads every plugin in the global config into every process it
 * runs: the TUI a person opens in a terminal, but also the `opencode acp` the
 * Vicoa daemon starts for a desktop session, and one-off commands such as
 * `opencode session list` that another agent runs from its shell. Those
 * processes inherit the parent session's VICOA_AGENT_INSTANCE_ID, so a plugin
 * that registered there took over the parent's session and ended it when the
 * command exited. The plugin stays off unless both checks below pass; when it
 * cannot tell, it stays off, since a wrong guess ends someone else's session.
 */
import { isMainThread } from 'worker_threads';

export type LaunchDecision = { active: true } | { active: false; reason: string };

export interface LaunchContext {
  env: NodeJS.ProcessEnv;
  argv: readonly string[];
  isMainThread: boolean;
}

/**
 * Set by the Vicoa daemon on every session it starts, and so inherited by
 * anything that session runs. `vicoa opencode` and a person's own terminal
 * never set them.
 */
const VICOA_SESSION_MARKERS = ['VICOA_AGENT_TYPE', 'VICOA_SPAWN_SOURCE'] as const;

/**
 * The interactive TUI runs the OpenCode server, and with it every plugin, in a
 * worker thread whose entry script is the TUI worker
 * (`/$bunfs/root/src/cli/tui/worker.js` in the release binary). Every other
 * command (`acp`, `run`, `serve`, `web`, `session list`, ...) loads plugins on
 * the main thread, with the subcommand in argv.
 */
const TUI_WORKER_ENTRY = /[\\/]tui[\\/]worker\.[cm]?[jt]sx?$/;

export function decideLaunch(ctx: LaunchContext): LaunchDecision {
  for (const name of VICOA_SESSION_MARKERS) {
    const value = ctx.env[name]?.trim();
    if (value) {
      return { active: false, reason: `started from a Vicoa session (${name}=${value})` };
    }
  }

  const entry = ctx.argv[1] ?? '';
  if (ctx.isMainThread || !TUI_WORKER_ENTRY.test(entry)) {
    const detail = ctx.isMainThread
      ? `command: opencode ${ctx.argv.slice(2).join(' ')}`.trimEnd()
      : `worker: ${entry || 'unknown'}`;
    return { active: false, reason: `not the interactive TUI (${detail})` };
  }

  return { active: true };
}

export function decideCurrentLaunch(): LaunchDecision {
  return decideLaunch({ env: process.env, argv: process.argv, isMainThread });
}
