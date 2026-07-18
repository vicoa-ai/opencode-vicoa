/**
 * Runtime smoke test for SessionMessagesWsClient against mock vicoa /ws servers.
 * Run with: bun scripts/ws-smoke-test.ts
 *
 * Each case boots a throwaway Bun WebSocket server that speaks the subset of
 * the protocol under test and asserts on what the client did.
 */
import { SessionMessagesWsClient } from '../src/plugin/session-ws-client.ts';

const failures: string[] = [];
const results: string[] = [];

function check(name: string, cond: boolean, detail = '') {
  if (cond) {
    results.push(`  ok   ${name}`);
  } else {
    failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
    results.push(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Case 1: handshake, catch-up, USER-only delivery, ping/pong, watermark carry.
// ---------------------------------------------------------------------------
async function testHappyPath() {
  const received: string[] = [];
  let helloFrame: any = null;
  let firstFetch: any = null;
  let secondFetch: any = null;
  let sawPong = false;
  let connectionCount = 0;
  let handshake: Record<string, string | null> = {};

  const server = Bun.serve({
    port: 0,
    fetch(req, srv) {
      handshake = {
        subprotocol: req.headers.get('sec-websocket-protocol'),
        cliVersion: req.headers.get('x-cli-version'),
      };
      if (srv.upgrade(req)) return;
      return new Response('expected ws', { status: 426 });
    },
    websocket: {
      open(ws) {
        connectionCount += 1;
        (ws as any).__n = connectionCount;
        ws.send(JSON.stringify({ type: 'server_info', body: { server_version: 'mock', user_id: 'u1' } }));
      },
      message(ws, raw) {
        const frame = JSON.parse(String(raw));
        const n = (ws as any).__n;
        if (frame.type === 'hello') {
          helloFrame = frame;
        } else if (frame.type === 'fetch_messages_request') {
          if (n === 1) {
            firstFetch = frame;
            // Catch-up rows: one AGENT (must be filtered), one USER.
            ws.send(JSON.stringify({
              type: 'fetch_messages_response',
              request_id: frame.request_id,
              instance_id: frame.instance_id,
              rows: [
                { t: 'new-message', id: 'm1', sender_type: 'AGENT', content: 'agent echo', created_at: '2026-06-02T00:00:01.000Z' },
                { t: 'new-message', id: 'm2', sender_type: 'USER', content: 'hello from user', created_at: '2026-06-02T00:00:02.000Z' },
              ],
              has_more: false,
            }));
            setTimeout(() => {
              ws.send(JSON.stringify({
                type: 'update',
                payload: { body: { t: 'new-message', id: 'm3', sender_type: 'USER', content: 'live message', created_at: '2026-06-02T00:00:03.000Z' } },
              }));
              ws.send(JSON.stringify({ type: 'ping' }));
              // Force a reconnect to verify the watermark carries forward.
              setTimeout(() => ws.close(), 100);
            }, 50);
          } else if (n === 2) {
            secondFetch = frame;
            ws.send(JSON.stringify({ type: 'fetch_messages_response', request_id: frame.request_id, instance_id: frame.instance_id, rows: [], has_more: false }));
          }
        } else if (frame.type === 'pong') {
          sawPong = true;
        }
      },
    },
  });

  const client = new SessionMessagesWsClient({
    wsUrl: `ws://localhost:${server.port}/ws`,
    apiKey: 'test-key',
    instanceId: 'inst-123',
    cliVersion: '0.1.0',
    onUserMessage: (content) => { received.push(content); },
    log: () => {},
  });
  client.start();
  await sleep(1500);
  client.stop();
  server.stop(true);

  // The credential rides on the subprotocol list, in the shape the server
  // expects: a `vicoa-ws` marker plus a `vicoa-key.<apikey>` entry.
  check('credential rides on the subprotocol list',
    handshake.subprotocol === 'vicoa-ws, vicoa-key.test-key', String(handshake.subprotocol));
  check('sends the CLI version header', handshake.cliVersion === '0.1.0', String(handshake.cliVersion));
  check('hello announces session-scoped', helloFrame?.scope === 'session-scoped', helloFrame?.scope);
  check('hello carries instance_id', helloFrame?.instance_id === 'inst-123', helloFrame?.instance_id);
  check('catch-up uses the catch-up request_id', firstFetch?.request_id === 'catch-up', firstFetch?.request_id);
  check('first fetch has a null cursor', firstFetch?.after === null, JSON.stringify(firstFetch?.after));
  check('delivers both USER messages', received.length === 2, JSON.stringify(received));
  check('catch-up row delivered first', received[0] === 'hello from user', received[0]);
  check('live update delivered second', received[1] === 'live message', received[1]);
  check('AGENT rows are filtered out', !received.includes('agent echo'));
  check('replies to ping with pong', sawPong);
  check('reconnects after a drop', secondFetch != null);
  check('reconnect fetch carries the watermark',
    secondFetch?.after?.created_at === '2026-06-02T00:00:03.000Z', JSON.stringify(secondFetch?.after));
}

// ---------------------------------------------------------------------------
// Case 2: a multi-row catch-up must hand messages to the callback strictly one
// at a time. The handler drives the TUI (appendPrompt -> submitPrompt); if two
// calls overlap the prompts interleave into one scrambled submission.
// ---------------------------------------------------------------------------
async function testDeliverySerialization() {
  const order: string[] = [];
  let concurrent = 0;
  let maxConcurrent = 0;

  const server = Bun.serve({
    port: 0,
    fetch(req, srv) { if (srv.upgrade(req)) return; return new Response('no', { status: 426 }); },
    websocket: {
      open(ws) { ws.send(JSON.stringify({ type: 'server_info', body: {} })); },
      message(ws, raw) {
        const frame = JSON.parse(String(raw));
        if (frame.type !== 'fetch_messages_request') return;
        ws.send(JSON.stringify({
          type: 'fetch_messages_response',
          request_id: frame.request_id,
          rows: ['a', 'b', 'c'].map((c, i) => ({
            t: 'new-message', id: `m${i}`, sender_type: 'USER', content: c,
            created_at: `2026-06-02T00:00:0${i}.000Z`,
          })),
          has_more: false,
        }));
        // A live update racing the catch-up must still land after it.
        setTimeout(() => ws.send(JSON.stringify({
          type: 'update',
          payload: { body: { t: 'new-message', id: 'm9', sender_type: 'USER', content: 'd', created_at: '2026-06-02T00:00:09.000Z' } },
        })), 5);
      },
    },
  });

  const client = new SessionMessagesWsClient({
    wsUrl: `ws://localhost:${server.port}/ws`,
    apiKey: 'k', instanceId: 'i1',
    onUserMessage: async (content) => {
      concurrent += 1;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      order.push(`${content}:start`);
      await sleep(30); // stand-in for appendPrompt + submitPrompt
      order.push(`${content}:end`);
      concurrent -= 1;
    },
    log: () => {},
  });
  client.start();
  await sleep(900);
  client.stop();
  server.stop(true);

  check('handler is never called concurrently', maxConcurrent === 1, `maxConcurrent=${maxConcurrent}`);
  check('handler calls do not interleave',
    order.join(',') === 'a:start,a:end,b:start,b:end,c:start,c:end,d:start,d:end', order.join(','));
}

// ---------------------------------------------------------------------------
// Case 3: close 4401 is fatal — the credential is dead, so reconnecting can
// never recover.
// ---------------------------------------------------------------------------
async function testCredentialRevokedIsFatal() {
  let connects = 0;
  let authFailureReason: string | null = null;

  const server = Bun.serve({
    port: 0,
    fetch(req, srv) { if (srv.upgrade(req)) return; return new Response('no', { status: 426 }); },
    websocket: {
      open(ws) {
        connects += 1;
        ws.send(JSON.stringify({ type: 'server_info', body: {} }));
        setTimeout(() => ws.close(4401, 'credential_revoked'), 10);
      },
      message() {},
    },
  });

  const client = new SessionMessagesWsClient({
    wsUrl: `ws://localhost:${server.port}/ws`,
    apiKey: 'dead-key', instanceId: 'i1',
    onUserMessage: () => {},
    onAuthFailure: (reason) => { authFailureReason = reason; },
    log: () => {},
  });
  client.start();
  await sleep(2500);
  client.stop();
  server.stop(true);

  check('stops reconnecting after 4401', connects === 1, `connects=${connects}`);
  check('reports the auth failure', authFailureReason === 'credential_revoked', String(authFailureReason));
}

// ---------------------------------------------------------------------------
// Case 4: accept-then-close (e.g. 4403 ownership) must back off. Resetting the
// backoff on onopen instead of on server_info turns this into a hot loop.
// ---------------------------------------------------------------------------
async function testBackoffOnAcceptThenClose() {
  let connects = 0;
  const server = Bun.serve({
    port: 0,
    fetch(req, srv) { if (srv.upgrade(req)) return; return new Response('no', { status: 426 }); },
    websocket: {
      // Accepted, then rejected before server_info — the ownership-check path.
      open(ws) { connects += 1; setTimeout(() => ws.close(4403, 'forbidden'), 5); },
      message() {},
    },
  });

  const client = new SessionMessagesWsClient({
    wsUrl: `ws://localhost:${server.port}/ws`,
    apiKey: 'k', instanceId: 'not-mine',
    onUserMessage: () => {},
    log: () => {},
  });
  client.start();
  await sleep(6000);
  client.stop();
  server.stop(true);

  // Full jitter means exact counts vary, but the two behaviours are far apart
  // over 6s: backing off gives ~4 attempts (mean delays 0.5s, 1s, 2s, 4s),
  // while resetting the backoff on every accept pins the delay at mean 0.5s
  // and yields ~12.
  check('backs off when the server accepts then rejects', connects <= 7, `connects=${connects} in 6s`);
}

// ---------------------------------------------------------------------------
// Case 5: has_more pagination. The server caps a page at 200 rows; without
// paging, the rest of the backlog waits for the next reconnect.
// ---------------------------------------------------------------------------
async function testPagination() {
  const received: string[] = [];
  const cursors: any[] = [];

  const server = Bun.serve({
    port: 0,
    fetch(req, srv) { if (srv.upgrade(req)) return; return new Response('no', { status: 426 }); },
    websocket: {
      open(ws) { ws.send(JSON.stringify({ type: 'server_info', body: {} })); },
      message(ws, raw) {
        const frame = JSON.parse(String(raw));
        if (frame.type !== 'fetch_messages_request') return;
        cursors.push(frame.after);
        if (frame.after?.id === 'p1') {
          ws.send(JSON.stringify({
            type: 'fetch_messages_response', request_id: frame.request_id,
            rows: [{ t: 'new-message', id: 'p2', sender_type: 'USER', content: 'page2', created_at: '2026-06-02T00:00:02.000Z' }],
            has_more: false,
          }));
        } else {
          ws.send(JSON.stringify({
            type: 'fetch_messages_response', request_id: frame.request_id,
            rows: [{ t: 'new-message', id: 'p1', sender_type: 'USER', content: 'page1', created_at: '2026-06-02T00:00:01.000Z' }],
            has_more: true,
          }));
        }
      },
    },
  });

  const client = new SessionMessagesWsClient({
    wsUrl: `ws://localhost:${server.port}/ws`,
    apiKey: 'k', instanceId: 'i1',
    onUserMessage: (c) => { received.push(c); },
    log: () => {},
  });
  client.start();
  await sleep(700);
  client.stop();
  server.stop(true);

  check('follows has_more to the next page', received.join(',') === 'page1,page2', received.join(','));
  check('pages with a strict (created_at, id) cursor',
    cursors[1]?.id === 'p1' && cursors[1]?.created_at === '2026-06-02T00:00:01.000Z', JSON.stringify(cursors[1]));
}

// ---------------------------------------------------------------------------
// Case 6: the liveness watchdog must reconnect when the server goes silent,
// without depending on onclose firing (a half-open link may never deliver it).
// ---------------------------------------------------------------------------
async function testLivenessWatchdog() {
  let connects = 0;
  const server = Bun.serve({
    port: 0,
    fetch(req, srv) { if (srv.upgrade(req)) return; return new Response('no', { status: 426 }); },
    websocket: {
      // Accept, complete the handshake, then never speak again.
      open(ws) { connects += 1; ws.send(JSON.stringify({ type: 'server_info', body: {} })); },
      message(ws, raw) {
        const frame = JSON.parse(String(raw));
        if (frame.type === 'fetch_messages_request') {
          ws.send(JSON.stringify({ type: 'fetch_messages_response', request_id: frame.request_id, rows: [], has_more: false }));
        }
      },
    },
  });

  const client = new SessionMessagesWsClient({
    wsUrl: `ws://localhost:${server.port}/ws`,
    apiKey: 'k', instanceId: 'i1',
    onUserMessage: () => {},
    livenessTimeoutMs: 250,
    log: () => {},
  });
  client.start();
  await sleep(1600);
  client.stop();
  server.stop(true);

  check('watchdog reconnects a silent link', connects >= 2, `connects=${connects}`);
}

// ---------------------------------------------------------------------------
// Case 7: a has_more page the client cannot page from (no usable cursor) must
// end the catch-up rather than leave the buffer closed forever.
// ---------------------------------------------------------------------------
async function testUnpageableCatchUpDoesNotWedge() {
  const received: string[] = [];

  const server = Bun.serve({
    port: 0,
    fetch(req, srv) { if (srv.upgrade(req)) return; return new Response('no', { status: 426 }); },
    websocket: {
      open(ws) { ws.send(JSON.stringify({ type: 'server_info', body: {} })); },
      message(ws, raw) {
        const frame = JSON.parse(String(raw));
        if (frame.type !== 'fetch_messages_request') return;
        // has_more, but the last row carries no id to page from.
        ws.send(JSON.stringify({
          type: 'fetch_messages_response', request_id: frame.request_id,
          rows: [{ t: 'new-message', sender_type: 'USER', content: 'partial', created_at: '2026-06-02T00:00:01.000Z' }],
          has_more: true,
        }));
        setTimeout(() => ws.send(JSON.stringify({
          type: 'update',
          payload: { body: { t: 'new-message', id: 'live1', sender_type: 'USER', content: 'after', created_at: '2026-06-02T00:00:05.000Z' } },
        })), 30);
      },
    },
  });

  const client = new SessionMessagesWsClient({
    wsUrl: `ws://localhost:${server.port}/ws`,
    apiKey: 'k', instanceId: 'i1',
    onUserMessage: (c) => { received.push(c); },
    log: () => {},
  });
  client.start();
  await sleep(700);
  client.stop();
  server.stop(true);

  check('live messages still flow after an unpageable catch-up',
    received.includes('after'), `received=${JSON.stringify(received)}`);
}

// ---------------------------------------------------------------------------
// Case 8: live traffic buffered when a connection dies mid-catch-up must not be
// dropped — it is undelivered, and the reconnect re-fetch dedupes any overlap.
// ---------------------------------------------------------------------------
async function testBufferedLiveSurvivesReconnect() {
  const received: string[] = [];
  let n = 0;

  const server = Bun.serve({
    port: 0,
    fetch(req, srv) { if (srv.upgrade(req)) return; return new Response('no', { status: 426 }); },
    websocket: {
      open(ws) { n += 1; (ws as any).__n = n; ws.send(JSON.stringify({ type: 'server_info', body: {} })); },
      message(ws, raw) {
        const frame = JSON.parse(String(raw));
        if (frame.type !== 'fetch_messages_request') return;
        if ((ws as any).__n === 1) {
          // Live update arrives before the fetch response, so it buffers...
          ws.send(JSON.stringify({
            type: 'update',
            payload: { body: { t: 'new-message', id: 'buffered1', sender_type: 'USER', content: 'buffered', created_at: '2026-06-02T00:00:01.000Z' } },
          }));
          // ...and the connection dies before the response releases it.
          setTimeout(() => ws.close(), 20);
        } else {
          // The re-fetch does not return it (e.g. it fell outside the window).
          ws.send(JSON.stringify({ type: 'fetch_messages_response', request_id: frame.request_id, rows: [], has_more: false }));
        }
      },
    },
  });

  const client = new SessionMessagesWsClient({
    wsUrl: `ws://localhost:${server.port}/ws`,
    apiKey: 'k', instanceId: 'i1',
    onUserMessage: (c) => { received.push(c); },
    log: () => {},
  });
  client.start();
  await sleep(2500);
  client.stop();
  server.stop(true);

  check('buffered live message survives a mid-catch-up drop',
    received.includes('buffered'), `received=${JSON.stringify(received)}`);
  check('and is delivered exactly once',
    received.filter((c) => c === 'buffered').length === 1, `received=${JSON.stringify(received)}`);
}

for (const [name, fn] of Object.entries({
  'happy path': testHappyPath,
  'delivery serialization': testDeliverySerialization,
  'credential revoked is fatal': testCredentialRevokedIsFatal,
  'backoff on accept-then-close': testBackoffOnAcceptThenClose,
  'has_more pagination': testPagination,
  'unpageable catch-up does not wedge': testUnpageableCatchUpDoesNotWedge,
  'buffered live survives reconnect': testBufferedLiveSurvivesReconnect,
  'liveness watchdog': testLivenessWatchdog,
})) {
  results.push(`\n${name}:`);
  await fn();
}

console.log(results.join('\n'));
if (failures.length) {
  console.error(`\nFAIL (${failures.length}):\n - ` + failures.join('\n - '));
  process.exit(1);
}
console.log('\nPASS: all assertions held');
process.exit(0);
