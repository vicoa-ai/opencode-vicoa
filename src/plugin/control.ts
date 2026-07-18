import type { VicoaClient } from './vicoa-client.js';
import { executeTuiCommand } from './commands.js';
import { log } from './utils.js'

type LogFn = (level: 'debug' | 'info' | 'warn' | 'error', message: string) => void;

type ControlCommandContext = {
  client: any;
  vicoaClient: VicoaClient;
  currentSessionId?: string;
  currentSessionStatus?: 'idle' | 'busy' | 'retry';
  getTuiCurrentAgent: () => string | undefined;
  setTuiCurrentAgent: (agent: string | undefined) => void;
  setPreferredAgent: (agent: string | undefined) => void;
  setTuiCurrentModel: (model: string | undefined) => void;
};

// Cycle the TUI's agent indicator to `targetAgent` by firing agent.cycle
// the right number of times.  The TUI wraps around at the end of the list,
// so we only need (targetIndex - currentIndex + len) % len steps.
// Returns true if the cycle was attempted, false if we couldn't determine
// the current position (e.g. no user message seen yet).
export async function cycleTuiToAgent(
  client: any,
  targetAgent: string,
  currentAgent: string | undefined
): Promise<boolean> {
  try {
    // Fetch the same filtered list the TUI uses: primary agents only, not hidden.
    // hey-api returns { data, error, … } when throwOnError is false (the default).
    const { data: allAgents } = await client.app.agents();
    const primaryAgents = (allAgents as Array<{ name: string; mode?: string; hidden?: boolean }>).filter(
      (a) => a.mode !== 'subagent' && !a.hidden,
    );

    const targetIdx = primaryAgents.findIndex((a) => a.name === targetAgent);
    if (targetIdx === -1) return false; // shouldn't happen — already validated

    // If we haven't seen a user message yet we don't know where the TUI is.
    // Optimistic fallback: assume it's on index 0 (the default agent).
    const currentName = currentAgent ?? primaryAgents[0]?.name;
    const currentIdx = primaryAgents.findIndex((a) => a.name === currentName);
    if (currentIdx === -1) return false;

    const steps = (targetIdx - currentIdx + primaryAgents.length) % primaryAgents.length;
    for (let i = 0; i < steps; i++) {
      await executeTuiCommand(client, 'agent.cycle');
    }
    return true;
  } catch {
    return false;
  }
}

function extractControlPayload(content: string): { setting?: string; value?: unknown } | null {
  const trimmed = content.trim();

  try {
    const parsed = JSON.parse(trimmed);
    const payload = parsed.control_command ?? (parsed.type === 'control' ? parsed : null);
    if (payload) {
      return payload;
    }
  } catch {
    // Ignore and try to scan embedded JSON
  }

  const candidates = trimmed.match(/\{[^{}]*\}/g) ?? [];
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      const payload = parsed.control_command ?? (parsed.type === 'control' ? parsed : null);
      if (payload) {
        return payload;
      }
    } catch {
      continue;
    }
  }

  return null;
}

/**
 * Handle control commands from Vicoa.
 *
 * Acknowledgements here are plain steps — never `requires_user_input`. That
 * flag is the notification trigger server-side (it fans out push/email/SMS,
 * and only defaults them off for plain steps), and the user just drove this
 * action from the app: pinging their phone about it is noise. The status these
 * acks want is applied by the caller instead, which follows a handled control
 * command with a plain updateStatus('AWAITING_INPUT') write.
 */
export async function handleControlCommand(content: string, context: ControlCommandContext): Promise<boolean> {
  const { client, vicoaClient, currentSessionId, currentSessionStatus, getTuiCurrentAgent, setPreferredAgent, setTuiCurrentAgent, setTuiCurrentModel } = context;

  // Try to parse as JSON control command
  try {
    const controlPayload = extractControlPayload(content);

    if (controlPayload) {
      const { setting, value } = controlPayload;

      if (setting === 'interrupt') {
        log(client, 'info', '[Vicoa] Interrupt command received');

        if (!currentSessionId) {
          await vicoaClient.sendMessage('Failed to interrupt');
          log(client, 'warn', '[Vicoa] Interrupt failed: no active session');
          return true;
        }

        // Check if OpenCode is idle
        if (currentSessionStatus === 'idle') {
          await vicoaClient.sendMessage('OpenCode is idle.');
          log(client, 'info', '[Vicoa] OpenCode is already idle, no interrupt needed');
          return true;
        }

        try {
            await executeTuiCommand(client, 'session.interrupt');
            await executeTuiCommand(client, 'session.interrupt');
            await vicoaClient.sendMessage('Interrupted');
            log(client, 'info', '[Vicoa] Interrupted');
          } catch (tuiError) {
            await vicoaClient.sendMessage('Failed to interrupt.');
            log(client, 'error', `[Vicoa] TUI interrupt failed: ${tuiError}`);
          }
        return true;
      }

      if (setting === 'agent_type') {
        const nextAgent = typeof value === 'string' ? value.toLowerCase() : '';
        if (!nextAgent) {
          log(client, 'warn', '[Vicoa] Agent type control command missing value');
          return true;
        }

        let selectedAgent = nextAgent;
        // Validate against the agents OpenCode actually knows about.
        // Filter to primary (non-subagent, non-hidden) — same set the TUI cycles through.
        try {
          const { data: agents } = await client.app.agents();
          const primaryAgents = (agents as Array<{ name: string; mode?: string; hidden?: boolean }>).filter(
            (a) => a.mode !== 'subagent' && !a.hidden,
          );
          const validNames = primaryAgents.map((a) => a.name);
          const match = validNames.find((n: string) => n.toLowerCase() === nextAgent);
          if (!match) {
            log(client, 'warn', `[Vicoa] Unknown agent "${nextAgent}". Available: ${validNames.join(', ')}`);
            await vicoaClient.sendMessage(`Unknown agent "${nextAgent}". Available agents: ${validNames.join(', ')}`);
            return true;
          }
          // Use the canonical casing returned by OpenCode
          selectedAgent = match;
          setPreferredAgent(match);

          // Cycle the TUI indicator so the terminal also shows the new agent.
          // session.prompt alone only affects a single message server-side;
          // the TUI's displayed agent is purely client-side state mutated by
          // agent.cycle commands.
          const cycled = await cycleTuiToAgent(client, match, getTuiCurrentAgent());
          if (cycled) {
            setTuiCurrentAgent(match);
            log(client, 'info', `[Vicoa] TUI agent indicator cycled to ${match}`);
          } else {
            log(client, 'warn', `[Vicoa] Could not cycle TUI to ${match}, will still route messages via session.prompt`);
          }
        } catch (error) {
          // If agent listing fails, accept the value optimistically
          log(client, 'warn', `[Vicoa] Could not list agents for validation: ${error}`);
          setPreferredAgent(nextAgent);
        }

        await vicoaClient.patchSessionConfig({ agent: 'opencode', opencode_mode: selectedAgent });
        await vicoaClient.sendMessage(`Agent changed to ${selectedAgent}.`);
        return true;
      }

      if (setting === 'model') {
        const modelValue = typeof value === 'string' ? value.trim() : '';
        if (!modelValue) {
          await vicoaClient.sendMessage('Invalid model: empty value.');
          return true;
        }

        let canonicalModel = modelValue;
        try {
          const { data: providerData } = await client.provider.list();
          const pd = providerData as {
            all: Array<{ id: string; models: Record<string, { name: string }> }>;
            connected: string[];
          };
          const connectedSet = new Set(pd.connected);
          const allModels: Array<{ slug: string; name: string }> = [];
          for (const provider of pd.all) {
            if (!connectedSet.has(provider.id)) continue;
            for (const [modelId, model] of Object.entries(provider.models)) {
              allModels.push({ slug: `${provider.id}/${modelId}`, name: model.name });
            }
          }
          const match = allModels.find(
            (m) => m.slug === modelValue || m.slug.endsWith(`/${modelValue}`)
          );
          if (!match) {
            const preview = allModels.slice(0, 10).map((m) => m.slug).join(', ');
            await vicoaClient.sendMessage(
              `Unknown model "${modelValue}". Available: ${preview}${allModels.length > 10 ? ` (+${allModels.length - 10} more)` : ''}.`
            );
            return true;
          }
          canonicalModel = match.slug;
        } catch (error) {
          log(client, 'warn', `[Vicoa] Could not list models for validation: ${error}`);
        }

        setTuiCurrentModel(canonicalModel);
        await vicoaClient.patchSessionConfig({ agent: 'opencode', model: canonicalModel });
        await vicoaClient.sendMessage(`Model changed to ${canonicalModel}.`);
        log(client, 'info', `[Vicoa] Model changed to ${canonicalModel}`);
        return true;
      }

      log(client, 'warn', `[Vicoa] Unknown control command: ${setting}`);
      return true;
    }
  } catch {
    // Not a JSON control command, treat as regular message
  }

  return false;
}
