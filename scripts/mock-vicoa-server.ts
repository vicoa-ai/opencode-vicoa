/**
 * Mock Vicoa server for local plugin testing — bypasses the real backend.
 * Run with: bun scripts/mock-vicoa-server.ts
 *
 * Speaks just enough of the protocol for the OpenCode plugin to initialize and
 * receive user messages over the WebSocket:
 *   - WS /ws: hello -> server_info, fetch_messages_request -> empty catch-up,
 *     ping/pong, and live `new-message` broadcasts.
 *   - The handful of REST endpoints the plugin hits at startup/runtime, with
 *     minimal valid responses. Agent-outbound messages are printed so you can
 *     watch the OpenCode -> "Vicoa" direction too.
 *
 * Inject a user message (OpenCode receives it over the WS) two ways:
 *   1. Type a line in THIS terminal and press Enter.
 *   2. curl -X POST localhost:8787/inject -d '{"content":"hello"}'
 */
import { randomUUID } from 'crypto';

const PORT = Number(process.env.MOCK_PORT || 8787);
const INSTANCE_ID = process.env.VICOA_AGENT_INSTANCE_ID || 'local-test-instance';

const sockets = new Set<any>();

function broadcastUserMessage(content: string): number {
  const body = {
    t: 'new-message',
    id: randomUUID(),
    instance_id: INSTANCE_ID,
    sender_type: 'USER',
    sender_user_id: 'mock-user',
    content,
    created_at: new Date().toISOString(),
    requires_user_input: false,
    message_metadata: null,
  };
  const frame = JSON.stringify({ type: 'update', payload: { body } });
  for (const ws of sockets) {
    try { ws.send(frame); } catch { /* dropped socket */ }
  }
  return sockets.size;
}

function j(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const server = Bun.serve({
  port: PORT,
  async fetch(req, srv) {
    const url = new URL(req.url);

    // --- WebSocket upgrade ---
    if (url.pathname === '/ws') {
      // Echo the vicoa-ws subprotocol like the real server does.
      const ok = srv.upgrade(req, { headers: { 'Sec-WebSocket-Protocol': 'vicoa-ws' } });
      return ok ? undefined : new Response('expected websocket', { status: 426 });
    }

    // --- inject a user message via HTTP ---
    if (url.pathname === '/inject' && req.method === 'POST') {
      const { content } = (await req.json().catch(() => ({}))) as { content?: string };
      if (!content) return j({ error: 'missing content' }, 400);
      const n = broadcastUserMessage(content);
      console.log(`\x1b[36m[inject]\x1b[0m -> ${n} socket(s): ${content}`);
      return j({ delivered_to: n });
    }

    // --- REST endpoints the plugin calls ---
    // Register is the only one whose response shape matters: a missing
    // agent_instance_id makes the plugin disable itself.
    if (url.pathname === '/api/v1/agent-instances' && req.method === 'POST') {
      const reqBody = (await req.json().catch(() => ({}))) as any;
      const id = reqBody.agent_instance_id || INSTANCE_ID;
      // machine_id is what links the session to a daemon so the app's
      // files/changes RPCs can be routed — print it so that path is visible.
      const machine = reqBody.machine_id ? ` machine_id=${reqBody.machine_id}` : ' machine_id=(none)';
      console.log(`\x1b[32m[register]\x1b[0m agent_instance_id=${id} type=${reqBody.agent_type}${machine}`);
      return j({ agent_instance_id: id });
    }

    // Agent-outbound messages — print so you can see OpenCode -> Vicoa traffic.
    if (url.pathname === '/api/v1/messages/agent' && req.method === 'POST') {
      const reqBody = (await req.json().catch(() => ({}))) as any;
      const preview = String(reqBody.content ?? '').replace(/\s+/g, ' ').slice(0, 120);
      console.log(`\x1b[33m[agent msg]\x1b[0m ${preview}`);
      return j({
        success: true,
        agent_instance_id: reqBody.agent_instance_id || INSTANCE_ID,
        message_id: randomUUID(),
        queued_user_messages: [],
      });
    }

    // Everything else under /api/v1/* — accept and no-op.
    if (url.pathname.startsWith('/api/v1/')) {
      return j({ success: true });
    }

    return new Response('mock-vicoa-server', { status: 200 });
  },

  websocket: {
    open(ws) {
      sockets.add(ws);
      console.log(`\x1b[35m[ws]\x1b[0m client connected (${sockets.size} total)`);
      ws.send(JSON.stringify({ type: 'server_info', body: { server_version: 'mock', user_id: 'mock-user' } }));
    },
    message(ws, raw) {
      let frame: any;
      try { frame = JSON.parse(String(raw)); } catch { return; }
      switch (frame.type) {
        case 'hello':
          console.log(`\x1b[35m[ws]\x1b[0m hello scope=${frame.scope} instance=${frame.instance_id}`);
          break;
        case 'fetch_messages_request':
          // No catch-up history in the mock — return an empty page.
          ws.send(JSON.stringify({
            type: 'fetch_messages_response',
            request_id: frame.request_id,
            instance_id: frame.instance_id,
            rows: [],
            has_more: false,
          }));
          break;
        case 'pong':
          // liveness ack — nothing to do
          break;
      }
    },
    close(ws) {
      sockets.delete(ws);
      console.log(`\x1b[35m[ws]\x1b[0m client disconnected (${sockets.size} total)`);
    },
  },
});

// Server pings every 30s, mirroring PING_INTERVAL_SECONDS — exercises the
// client's pong + liveness watchdog.
setInterval(() => {
  for (const ws of sockets) {
    try { ws.send(JSON.stringify({ type: 'ping' })); } catch { /* dropped */ }
  }
}, 30000);

// Inject messages by typing in this terminal.
console.log(`\x1b[1mMock Vicoa server on http://localhost:${server.port}\x1b[0m`);
console.log(`  WS endpoint:  ws://localhost:${server.port}/ws`);
console.log(`  Point the plugin at it:  export VICOA_API_URL="http://localhost:${server.port}"`);
console.log(`  Type a message + Enter to send it to OpenCode. Ctrl+C to quit.\n`);

for await (const line of console) {
  const content = line.trim();
  if (content) {
    const n = broadcastUserMessage(content);
    console.log(`\x1b[36m[inject]\x1b[0m -> ${n} socket(s)`);
  }
}
