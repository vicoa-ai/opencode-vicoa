/**
 * Vicoa API client for OpenCode plugin
 *
 * This client uses Vicoa's existing REST APIs to communicate with the dashboard.
 * It mimics the Python VicoaClient functionality but runs in TypeScript/Node.js.
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

export class VicoaClient {
  private config: VicoaClientConfig;
  public lastMessageId: string | null = null;
  private log: (level: string, msg: string) => void;

  constructor(config: VicoaClientConfig) {
    this.config = config;
    this.log = config.logFunc || ((level, msg) => console.log(`[${level}] ${msg}`));
  }

  /**
   * Register agent instance with Vicoa backend
   */
  async registerAgentInstance(project: string, homeDir: string): Promise<{ agent_instance_id: string }> {
    const response = await fetch(`${this.config.baseUrl}/api/v1/agent-instances`, {
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
      const response = await fetch(`${this.config.baseUrl}/api/v1/commands/sync`, {
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
      const response = await fetch(`${this.config.baseUrl}/api/v1/messages/agent`, {
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
      }

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
      const response = await fetch(`${this.config.baseUrl}/api/v1/messages/user`, {
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

      // Update last message ID
      if (result.message_id) {
        this.lastMessageId = result.message_id;
      }

      return result.message_id;
    } catch (error) {
      this.log('warn', `Error sending user message: ${error}`);
      return null;
    }
  }

  /**
   * Poll for pending user messages from Vicoa dashboard
   */
  async getPendingMessages(): Promise<VicoaMessage[]> {
    try {
      const url = new URL(`${this.config.baseUrl}/api/v1/messages/pending`);
      url.searchParams.set('agent_instance_id', this.config.agentInstanceId);
      if (this.lastMessageId) {
        url.searchParams.set('last_read_message_id', this.lastMessageId);
      }

      const response = await fetch(url.toString(), {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${this.config.apiKey}`,
        },
      });

      if (!response.ok) {
        // Polling errors are non-fatal
        this.log('debug', `Failed to poll messages: ${response.statusText}`);
        return [];
      }

      const result = (await response.json()) as {
        agent_instance_id: string;
        messages: VicoaMessage[];
        status: string;
      };

      // Check if the response is stale
      if (result.status === 'stale') {
        this.log('debug', 'Message polling returned stale status');
        return [];
      }

      const messages = result.messages || [];

      // Update last message ID
      if (messages.length > 0) {
        const lastMsg = messages[messages.length - 1];
        this.lastMessageId = lastMsg.id;
      }

      return messages;
    } catch (error) {
      this.log('debug', `Error polling messages: ${error}`);
      return [];
    }
  }

  /**
   * Request user input (equivalent to Claude wrapper's request_user_input)
   */
  async requestUserInput(messageId: string): Promise<void> {
    try {
      const response = await fetch(
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
      }
    } catch (error) {
      this.log('warn', `Error requesting user input: ${error}`);
    }
  }

  /**
   * Update agent instance status
   */
  async updateStatus(
    status:
      | 'ACTIVE'
      | 'AWAITING_INPUT'
      | 'PAUSED'
      | 'STALE'
      | 'COMPLETED'
      | 'FAILED'
      | 'KILLED'
      | 'DISCONNECTED'
      | 'DELETED'
  ): Promise<void> {
    try {
      const response = await fetch(
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
      }
    } catch (error) {
      this.log('warn', `Error updating status: ${error}`);
    }
  }

  /**
   * Update agent instance title/name
   */
  async updateAgentInstanceName(name: string): Promise<void> {
    try {
      const response = await fetch(
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
   * End session
   */
  async endSession(): Promise<void> {
    await this.updateStatus('COMPLETED');

    try {
      const response = await fetch(
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
