/**
 * Vicoa API client for OpenCode plugin
 *
 * This client uses Vicoa's REST APIs to communicate with the dashboard.
 */

export interface VicoaClientConfig {
  apiKey: string;
  baseUrl: string;
  agentType: string;
  agentInstanceId: string;
  logFunc?: (level: string, msg: string) => void;
}

export interface VicoaMessage {
  id: string;
  content: string;
  sender_type: 'USER' | 'AGENT';
  requires_user_input: boolean;
  created_at: string;
}

export type AgentInstanceStatus =
  | 'ACTIVE'
  | 'AWAITING_INPUT'
  | 'PAUSED'
  | 'STALE'
  | 'COMPLETED'
  | 'FAILED'
  | 'KILLED'
  | 'DISCONNECTED'
  | 'DELETED';

function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (!value) {
    return fallback;
  }

  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }

  return parsed;
}

export class VicoaClient {
  private config: VicoaClientConfig;
  public lastMessageId: string | null = null;

  /**
   * The last message we posted as the AGENT, or null if the last one was the
   * user's. Tracked apart from `lastMessageId` because requestUserInput only
   * accepts agent messages — the endpoint filters on
   * `sender_type == SenderType.AGENT` and 404s otherwise — and `lastMessageId`
   * is also advanced by sendUserMessage when the user types in the terminal.
   */
  public lastAgentMessageId: string | null = null;
  private log: (level: string, msg: string) => void;
  private requestTimeoutMs: number;

  /**
   * Our best knowledge of `instance.status` server-side, used to skip
   * no-op status writes.
   *
   * Writing a message is itself a status change: the backend sets the row to
   * ACTIVE — or AWAITING_INPUT for a `requires_user_input` message — as a side
   * effect of the insert. So this is maintained by the message paths too, not
   * just updateStatus; a cache that only tracked explicit writes would go stale
   * on the first message sent and start suppressing the writes that matter.
   */
  private knownStatus: AgentInstanceStatus | undefined;

  constructor(config: VicoaClientConfig) {
    this.config = config;
    this.log = config.logFunc || ((level, msg) => console.log(`[${level}] ${msg}`));
    this.requestTimeoutMs = parsePositiveInt(process.env.VICOA_HTTP_TIMEOUT_MS, 10000);
  }

  private async fetchWithTimeout(
    url: string,
    init: RequestInit,
    timeoutMs: number = this.requestTimeoutMs
  ): Promise<Response> {
    const controller = new AbortController();
    const timeoutHandle = setTimeout(() => {
      controller.abort();
    }, timeoutMs);

    try {
      return await fetch(url, {
        ...init,
        signal: controller.signal,
      });
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        throw new Error(`Request timed out after ${timeoutMs}ms`);
      }
      throw error;
    } finally {
      clearTimeout(timeoutHandle);
    }
  }

  /**
   * Register agent instance with Vicoa backend.
   *
   * `machineId` links the session to the machine it runs on so the app can
   * route file/git RPCs (list-files, git-diff) to that machine's daemon. Omit
   * it when no daemon is registered locally — the backend drops an unknown or
   * foreign id to null anyway, and without a daemon there is nothing to serve
   * those RPCs regardless.
   */
  async registerAgentInstance(
    project: string,
    homeDir: string,
    machineId?: string | null
  ): Promise<{ agent_instance_id: string }> {
    const response = await this.fetchWithTimeout(`${this.config.baseUrl}/api/v1/agent-instances`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.config.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        agent_type: this.config.agentType,
        transport: 'local',
        agent_instance_id: this.config.agentInstanceId,
        name: this.config.agentType,
        project,
        home_dir: homeDir,
        source: 'terminal',
        ...(machineId ? { machine_id: machineId } : {}),
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Failed to register agent instance: ${response.statusText} - ${error}`);
    }

    return (await response.json()) as { agent_instance_id: string };
  }

  /**
    * Sync custom slash commands to Vicoa backend
    */
  async syncCommands(
    agentType: string,
    commands: Record<string, { description: string }>
  ): Promise<void> {
    try {
      const response = await this.fetchWithTimeout(`${this.config.baseUrl}/api/v1/commands/sync`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.config.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          agent_type: agentType,
          commands,
        }),
      });

      if (!response.ok) {
        const error = await response.text();
        this.log('warn', `Failed to sync slash commands: ${response.statusText} - ${error}`);
      }
    } catch (error) {
      this.log('warn', `Error syncing slash commands: ${error}`);
    }
  }

  /**
   * Send agent message to Vicoa dashboard
   */
  async sendMessage(content: string, requiresUserInput: boolean = false): Promise<string | null> {
    try {
      const response = await this.fetchWithTimeout(`${this.config.baseUrl}/api/v1/messages/agent`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.config.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          content,
          agent_type: this.config.agentType,
          agent_instance_id: this.config.agentInstanceId,
          requires_user_input: requiresUserInput,
        }),
      });

      if (!response.ok) {
        const error = await response.text();
        this.log('warn', `Failed to send message: ${response.statusText} - ${error}`);
        return null;
      }

      const result = (await response.json()) as {
        success: boolean;
        agent_instance_id: string;
        message_id: string;
        queued_user_messages: VicoaMessage[];
      };

      // Update last message ID for polling
      if (result.message_id) {
        this.lastMessageId = result.message_id;
        this.lastAgentMessageId = result.message_id;
      }

      // Mirror the status the insert just applied server-side.
      this.knownStatus = requiresUserInput ? 'AWAITING_INPUT' : 'ACTIVE';

      return result.message_id;
    } catch (error) {
      this.log('warn', `Error sending message: ${error}`);
      return null;
    }
  }

  /**
   * Send user message from terminal to Vicoa dashboard
   * This is used when the user types a message directly in the OpenCode terminal
   */
  async sendUserMessage(content: string): Promise<string | null> {
    try {
      const response = await this.fetchWithTimeout(`${this.config.baseUrl}/api/v1/messages/user`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.config.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          content,
          agent_instance_id: this.config.agentInstanceId,
        }),
      });

      if (!response.ok) {
        const error = await response.text();
        this.log('warn', `Failed to send user message: ${response.statusText} - ${error}`);
        return null;
      }

      const result = (await response.json()) as {
        success: boolean;
        message_id: string;
      };

      // Update last message ID. Deliberately not lastAgentMessageId: this row
      // is the user's, and requestUserInput would 404 on it.
      if (result.message_id) {
        this.lastMessageId = result.message_id;
      }

      // A user-message insert reactivates the instance server-side.
      this.knownStatus = 'ACTIVE';

      return result.message_id;
    } catch (error) {
      this.log('warn', `Error sending user message: ${error}`);
      return null;
    }
  }

  /**
   * Request user input for the last agent message.
   *
   * This is the end-of-turn "your agent needs you" signal: server-side it flags
   * the message, moves the instance to AWAITING_INPUT, and fires the push/email/
   * SMS notification — but only when the user has not already typed ahead, in
   * which case the queued messages are coming to us anyway and the instance
   * stays ACTIVE. That queued-aware behaviour is why the turn-end transition
   * goes through here rather than a blind updateStatus('AWAITING_INPUT').
   *
   * Not idempotent: re-flagging an already-flagged message is a 400, so callers
   * must not mark the same message twice (the plugin tracks the last flagged id
   * in `markedRequestInputId`). Only agent messages are accepted — pass
   * `lastAgentMessageId`, never `lastMessageId`.
   *
   * Returns whether the flag landed. On false the instance status is untouched,
   * so the caller still owes it a settle.
   */
  async requestUserInput(messageId: string): Promise<boolean> {
    try {
      const response = await this.fetchWithTimeout(
        `${this.config.baseUrl}/api/v1/messages/${messageId}/request-input`,
        {
          method: 'PATCH',
          headers: {
            'Authorization': `Bearer ${this.config.apiKey}`,
          },
        }
      );

      if (!response.ok) {
        this.log('warn', `Failed to request user input: ${response.statusText}`);
        return false;
      }

      // Either the instance is now AWAITING_INPUT, or the user typed ahead and
      // it deliberately stayed ACTIVE. We cannot tell which without reading the
      // body, so drop the cache rather than record a guess.
      this.knownStatus = undefined;
      return true;
    } catch (error) {
      this.log('warn', `Error requesting user input: ${error}`);
      return false;
    }
  }

  /**
   * Update agent instance status.
   *
   * A no-op write is skipped: OpenCode emits a status event per turn boundary
   * and the plugin also reacts to session.idle, so without this the same value
   * is PUT several times a turn.
   */
  async updateStatus(status: AgentInstanceStatus): Promise<void> {
    if (this.knownStatus === status) {
      return;
    }
    // Claim the value before awaiting, not after. Status writes are fired from
    // independent async paths (the event hook and the WS delivery chain), and
    // leaving the cache on its old value for the duration of the request lets a
    // concurrent call for that old value see a false miss — or worse, a call for
    // the *pre-write* value see a false hit and skip the PUT it needed.
    this.knownStatus = status;

    try {
      const response = await this.fetchWithTimeout(
        `${this.config.baseUrl}/api/v1/agent-instances/${this.config.agentInstanceId}/status`,
        {
          method: 'PUT',
          headers: {
            'Authorization': `Bearer ${this.config.apiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ status }),
        }
      );

      if (!response.ok) {
        this.log('warn', `Failed to update status: ${response.statusText}`);
        // The row is not on `status` after all, and we no longer know what it
        // is on. Clearing rather than restoring lets the next write retry.
        this.knownStatus = undefined;
      }
    } catch (error) {
      this.log('warn', `Error updating status: ${error}`);
      this.knownStatus = undefined;
    }
  }

  /**
   * Update agent instance title/name
   */
  async updateAgentInstanceName(name: string): Promise<void> {
    try {
      const response = await this.fetchWithTimeout(
        `${this.config.baseUrl}/api/v1/agent-instances/${this.config.agentInstanceId}`,
        {
          method: 'PATCH',
          headers: {
            'Authorization': `Bearer ${this.config.apiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ name }),
        }
      );

      if (!response.ok) {
        this.log('warn', `Failed to update agent instance name: ${response.statusText}`);
      }
    } catch (error) {
      this.log('warn', `Error updating agent instance name: ${error}`);
    }
  }

  /**
   * Patch session_config on the agent instance row (merges key-by-key).
   */
  async patchSessionConfig(config: Record<string, unknown>): Promise<void> {
    try {
      const response = await this.fetchWithTimeout(
        `${this.config.baseUrl}/api/v1/agent-instances/${this.config.agentInstanceId}`,
        {
          method: 'PATCH',
          headers: {
            'Authorization': `Bearer ${this.config.apiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ session_config: config }),
        }
      );

      if (!response.ok) {
        this.log('warn', `Failed to patch session config: ${response.statusText}`);
      }
    } catch (error) {
      this.log('warn', `Error patching session config: ${error}`);
    }
  }

  /**
   * End session
   */
  async endSession(): Promise<void> {
    // Force the write through: COMPLETED is terminal and fires the
    // terminate NOTIFY, so it must never be skipped as a cache hit.
    this.knownStatus = undefined;
    await this.updateStatus('COMPLETED');

    try {
      const response = await this.fetchWithTimeout(
        `${this.config.baseUrl}/api/v1/sessions/end`,
        {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${this.config.apiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            agent_instance_id: this.config.agentInstanceId,
          }),
        }
      );

      if (!response.ok) {
        this.log('warn', `Failed to end session: ${response.statusText}`);
      }
    } catch (error) {
      this.log('warn', `Error ending session: ${error}`);
    }
  }
}
