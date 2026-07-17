/**
 * Read-only access to the daemon state file (`~/.vicoa/daemon_state.json`).
 *
 * The machine daemon persists its `machine_id` here at registration. A session
 * must carry that id for the app to route file/git RPCs (list-files, git-diff,
 * git-status) — those are served by the daemon, and the app addresses them by
 * the session's `machine_id`. A session registered without one shows no files
 * or changes in the app even though a daemon is running on the same machine.
 *
 * The file holds a `daemons` map keyed by normalized base URL so a machine can
 * run daemons against several backends at once (e.g. prod + staging). Legacy
 * files kept `machine_id` at the top level; we read that shape too. This is
 * read-only — the plugin never writes the file; only the daemon does.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const DEFAULT_API_URL = 'https://agents.vicoa.ai';

interface DaemonEntry {
  machine_id?: unknown;
}

/** Path to the daemon state file. */
export function getDaemonStatePath(): string {
  return path.join(os.homedir(), '.vicoa', 'daemon_state.json');
}

/**
 * Canonical key used to look up a daemon entry by its base URL.
 *
 * Strips trailing slashes and lowercases so `https://Agents.Vicoa.AI/` and
 * `https://agents.vicoa.ai` resolve to the same entry. Falls back to the
 * default API URL when the caller passes nothing.
 */
export function normalizeBaseUrl(url: string | undefined): string {
  return (url || DEFAULT_API_URL).trim().replace(/\/+$/, '').toLowerCase();
}

/**
 * Resolve the persisted `machine_id` for `baseUrl`, or null.
 *
 * Never throws: a missing file, malformed JSON, or an absent/blank id all yield
 * null so registration falls back to an unlinked session rather than failing.
 */
export function readMachineId(baseUrl: string | undefined): string | null {
  const statePath = getDaemonStatePath();
  if (!fs.existsSync(statePath)) {
    return null;
  }

  let state: Record<string, unknown>;
  try {
    const parsed = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
    if (!parsed || typeof parsed !== 'object') {
      return null;
    }
    state = parsed as Record<string, unknown>;
  } catch {
    return null;
  }

  const key = normalizeBaseUrl(baseUrl);

  // Current shape: { daemons: { <normalized-url>: { machine_id } } }.
  const daemons = state.daemons;
  if (daemons && typeof daemons === 'object') {
    const entry = (daemons as Record<string, DaemonEntry>)[key];
    const id = entry?.machine_id;
    if (typeof id === 'string' && id) {
      return id;
    }
    return null;
  }

  // Legacy flat shape: { machine_id } at the top level, treated as the entry
  // for the default API URL (what the daemon migration assumes on first read).
  if (key === normalizeBaseUrl(DEFAULT_API_URL)) {
    const legacy = state.machine_id;
    if (typeof legacy === 'string' && legacy) {
      return legacy;
    }
  }

  return null;
}
