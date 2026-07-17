/**
 * Session-scoped WebSocket client for the OpenCode plugin.
 *
 * The user→agent transport. Connects to `/ws` as `session-scoped` and receives
 * user messages as live `new-message` updates. On every (re)connect it sends a
 * `fetch_messages_request` to catch up on messages missed while disconnected;
 * live updates that arrive before the `fetch_messages_response` are buffered so
 * history is delivered in order.
 *
 * OpenCode runs under Bun, whose global WHATWG `WebSocket` is event-driven
 * (`onopen`/`onmessage`/`onclose`), so no `ws`/`undici` dependency is needed:
 * Bun ships a global `WebSocket` and accepts `{ headers, protocols }`.
 *
 * Outbound traffic (sendMessage, status, permission replies) stays on REST —
 * only the user→agent direction runs over the WebSocket.
 */

const CATCH_UP_REQUEST_ID = 'catch-up';

// Full-jitter reconnect backoff (base 1s, cap 30s), applied from the first
// attempt so a mass-disconnect herd spreads out instead of retrying in a
// synchronized wave.
const DEFAULT_BACKOFF_BASE_MS = 1000;
const DEFAULT_BACKOFF_CAP_MS = 30000;

// Liveness watchdog. The server pings every ~30s and we answer with a pong; two
// missed pings (~60s of silence) means the link is dead even if the OS hasn't
// surfaced a TCP close yet. 70s ≈ 2 missed pings.
const DEFAULT_LIVENESS_TIMEOUT_MS = 70000;

// RFC 6455 private-use range. The server pushes 4401 on an *established*
// connection when the credential dies under it (e.g. the account was deleted).
// Reconnecting against a revoked credential never recovers, so this is fatal
// rather than transient.
//
// This does not cover a rejected *handshake*: the server closes 4401 there
// before accepting the socket, which becomes an HTTP 403, and the WebSocket API
// reports that as a plain 1006 with no code to read. An expired key is
// therefore indistinguishable from a network fault and keeps retrying on the
// backoff.
const WS_CLOSE_CREDENTIAL_REVOKED = 4401;

// Cap on the delivered-id set used to dedupe the reconnect safety-window
// overlap. The server re-fetches a ~30s window on reconnect and pages at 200
// rows, so a few hundred ids covers any real overlap; the cap only exists so a
// long-lived session does not accumulate every id it ever saw. Evicts
// oldest-first, which are the ones furthest outside the window.
const MAX_SEEN_IDS = 1000;

/** A message body in the `new-message` live-frame shape. */
export interface SessionMessageBody {
  t?: string;
  id?: string;
  instance_id?: string;
  sender_type?: 'USER' | 'AGENT';
  sender_user_id?: string | null;
  content?: string;
  created_at?: string;
  requires_user_input?: boolean;
  message_metadata?: unknown;
}

/** The reconnect watermark — `created_at` of the latest delivered message. */
interface Watermark {
  created_at: string;
}

/**
 * The `after` cursor sent on a `fetch_messages_request`.
 *
 * Two shapes, distinguished server-side by the presence of `id`:
 *   - `{created_at}`      — reconnect watermark; re-fetches from
 *     `created_at - 30s` and relies on the client deduping the overlap.
 *   - `{created_at, id}`  — pagination cursor continuing a `has_more`
 *     response; strict `(created_at, id) >`, no safety window.
 */
type FetchCursor = Watermark | { created_at: string; id: string };

/**
 * Holds live `new-message` bodies until catch-up completes.
 *
 * A live update may arrive between the `fetch_messages_request` and its
 * response; buffering it until the catch-up rows are delivered keeps message
 * order correct. The `seen` set persists across reconnects so the safety-window
 * overlap on the re-fetch is not re-delivered.
 */
class CatchUpBuffer {
  private buffered: SessionMessageBody[] = [];
  private fetchComplete = false;
  private seen = new Set<string>();

  /**
   * Start a fresh catch-up cycle (called on every (re)connect and on resync).
   *
   * Anything still buffered is kept rather than dropped: it is live traffic
   * that has not been delivered yet, and the connection died (or the cursor was
   * rejected) before the fetch that would have released it. The upcoming
   * catch-up will usually re-fetch the same rows, and `seen` collapses the
   * duplicates — whereas clearing here would silently lose them.
   */
  beginCatchUp(): void {
    this.fetchComplete = false;
  }

  /** Take a live body; return bodies ready to deliver now (held back pre-fetch). */
  bufferLive(body: SessionMessageBody): SessionMessageBody[] {
    if (this.fetchComplete) {
      return this.dedupe([body]);
    }
    this.buffered.push(body);
    return [];
  }

  /**
   * A catch-up page arrived: deliver its rows, and once the last page is in,
   * the live updates buffered behind it.
   *
   * `hasMore` keeps the buffer closed so a paginated catch-up still delivers
   * the whole backlog ahead of anything that arrived live meanwhile.
   */
  completeFetch(rows: SessionMessageBody[], hasMore: boolean): SessionMessageBody[] {
    if (hasMore) {
      return this.dedupe(rows);
    }
    const delivered = this.dedupe([...rows, ...this.buffered]);
    this.buffered = [];
    this.fetchComplete = true;
    return delivered;
  }

  /** Drop bodies whose id was already delivered (first-write-wins). */
  private dedupe(bodies: SessionMessageBody[]): SessionMessageBody[] {
    const fresh: SessionMessageBody[] = [];
    for (const body of bodies) {
      const id = body.id;
      if (id === undefined || !this.seen.has(id)) {
        if (id !== undefined) this.seen.add(id);
        fresh.push(body);
      }
    }
    // Sets iterate in insertion order, so the front is the oldest.
    if (this.seen.size > MAX_SEEN_IDS) {
      for (const id of this.seen) {
        if (this.seen.size <= MAX_SEEN_IDS) break;
        this.seen.delete(id);
      }
    }
    return fresh;
  }
}

export interface SessionMessagesWsClientOptions {
  wsUrl: string;
  apiKey: string;
  instanceId: string;
  /**
   * Called once per fresh USER message, with its content. AGENT messages are
   * filtered out. Awaited, and never called concurrently with itself — see
   * `deliver`.
   */
  onUserMessage: (content: string) => void | Promise<void>;
  /**
   * Called when the server rejects the credential (close 4401). The client has
   * stopped by this point and will not reconnect.
   */
  onAuthFailure?: (reason: string) => void;
  cliVersion?: string;
  log?: (level: string, msg: string) => void;
  /** Override the liveness watchdog window. Exposed for tests. */
  livenessTimeoutMs?: number;
}

/**
 * Maintains a session-scoped /ws connection that delivers user messages.
 *
 * `start()` kicks off the connect/reconnect cycle; `stop()` tears it down. On
 * every (re)connect a `fetch_messages_request` catches up missed messages; each
 * delivered message advances a `created_at` watermark used as the next
 * reconnect's catch-up cursor.
 */
export class SessionMessagesWsClient {
  private readonly wsUrl: string;
  private readonly apiKey: string;
  private readonly instanceId: string;
  private readonly onUserMessage: (content: string) => void | Promise<void>;
  private readonly onAuthFailure?: (reason: string) => void;
  private readonly cliVersion?: string;
  private readonly log: (level: string, msg: string) => void;
  private readonly livenessTimeoutMs: number;

  private readonly buffer = new CatchUpBuffer();
  private watermark: Watermark | null = null;

  private socket: WebSocket | null = null;
  private stopped = false;
  private attempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private livenessTimer: ReturnType<typeof setTimeout> | null = null;
  // Serializes onUserMessage calls across frames — see `deliver`.
  private deliveryChain: Promise<void> = Promise.resolve();

  constructor(options: SessionMessagesWsClientOptions) {
    this.wsUrl = options.wsUrl;
    this.apiKey = options.apiKey;
    this.instanceId = options.instanceId;
    this.onUserMessage = options.onUserMessage;
    this.onAuthFailure = options.onAuthFailure;
    this.cliVersion = options.cliVersion;
    this.log = options.log || ((level, msg) => console.log(`[${level}] ${msg}`));
    this.livenessTimeoutMs = options.livenessTimeoutMs ?? DEFAULT_LIVENESS_TIMEOUT_MS;
  }

  /** Begin the connect/reconnect cycle. Idempotent. */
  start(): void {
    if (this.stopped || this.socket || this.reconnectTimer) {
      return;
    }
    this.log('info', 'Starting session WebSocket client');
    this.connect();
  }

  /** Stop the client and close any open socket. */
  stop(): void {
    this.stopped = true;
    this.clearReconnectTimer();
    this.clearLivenessTimer();
    const socket = this.socket;
    this.socket = null;
    if (socket) {
      try {
        socket.close();
      } catch {
        // best-effort close
      }
    }
    this.log('info', 'Stopped session WebSocket client');
  }

  // ------------------------------------------------------------------
  // Connection lifecycle
  // ------------------------------------------------------------------

  private connect(): void {
    this.clearReconnectTimer();
    if (this.stopped) {
      return;
    }

    // Auth + protocol selection ride on the subprotocol list: `vicoa-ws` is the
    // protocol marker, `vicoa-key.<apikey>` carries the agent JWT. The CLI
    // version goes in a header (Bun's WebSocket accepts a non-standard
    // `{ headers }` option).
    const protocols = ['vicoa-ws', `vicoa-key.${this.apiKey}`];
    const headers: Record<string, string> = {};
    if (this.cliVersion) {
      headers['X-CLI-Version'] = this.cliVersion;
    }

    let socket: WebSocket;
    try {
      socket = new WebSocket(this.wsUrl, { headers, protocols } as any);
    } catch (error) {
      this.log('warn', `Session WS connect failed to construct: ${error}`);
      this.scheduleReconnect();
      return;
    }
    this.socket = socket;

    // Every handler below ignores events from a socket we have already moved on
    // from. `stop()` and the liveness watchdog both detach by clearing
    // `this.socket`, and a superseded socket can still emit a late onclose —
    // without this guard that close would schedule a second, concurrent
    // reconnect and orphan the socket the first one just opened.
    const isCurrent = () => this.socket === socket;

    socket.onopen = () => {
      if (!isCurrent()) return;
      this.armLiveness();
      // hello announces scope; the server replies with `server_info`, after
      // which we send the catch-up fetch (see handleFrame).
      this.send({
        type: 'hello',
        scope: 'session-scoped',
        instance_id: this.instanceId,
      });
    };

    socket.onmessage = (event: MessageEvent) => {
      if (!isCurrent()) return;
      this.armLiveness();
      let frame: any;
      try {
        frame = JSON.parse(typeof event.data === 'string' ? event.data : String(event.data));
      } catch (error) {
        this.log('warn', `Session WS dropping unparseable frame: ${error}`);
        return;
      }
      this.handleFrame(frame);
    };

    socket.onerror = (event: Event) => {
      // onerror is always followed by onclose; log here, reconnect there.
      this.log('debug', `Session WS error event: ${(event as any)?.message ?? 'unknown'}`);
    };

    // Structurally typed: the close event carries `code`/`reason` under both
    // Bun's and Node's WebSocket, but `CloseEvent` is only a global with the
    // DOM lib, which this package does not pull in.
    socket.onclose = (event: { code?: number; reason?: string }) => {
      if (!isCurrent()) return;
      this.clearLivenessTimer();
      this.socket = null;

      if (event?.code === WS_CLOSE_CREDENTIAL_REVOKED) {
        const reason = event.reason || 'credential_revoked';
        this.log('error', `Session WS rejected the credential (${event.code}: ${reason}); not reconnecting`);
        this.stopped = true;
        this.clearReconnectTimer();
        this.onAuthFailure?.(reason);
        return;
      }

      if (!this.stopped) {
        this.scheduleReconnect();
      }
    };
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) {
      return;
    }
    const delay = this.fullJitterDelayMs(this.attempt);
    this.attempt += 1;
    this.log('debug', `Session WS reconnecting in ${Math.round(delay)}ms`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  /** `random(0, min(cap, base * 2**attempt))`, attempt clamped to avoid overflow. */
  private fullJitterDelayMs(attempt: number): number {
    const shift = Math.min(attempt, 30);
    const ceiling = Math.min(DEFAULT_BACKOFF_CAP_MS, DEFAULT_BACKOFF_BASE_MS * 2 ** shift);
    return Math.random() * ceiling;
  }

  // ------------------------------------------------------------------
  // Frame handling
  // ------------------------------------------------------------------

  private handleFrame(frame: any): void {
    const type = frame?.type;
    if (type === 'ping') {
      this.send({ type: 'pong' });
    } else if (type === 'server_info') {
      // Handshake accepted *and* the server-side ownership check passed — this
      // is the first proof the connection is actually usable, so it is where
      // the backoff resets. Resetting in onopen instead would clear it before
      // a 4403 ownership rejection could be seen, turning a permanent failure
      // into a hot reconnect loop.
      this.attempt = 0;
      // begin/seen state is per-connection; the dedupe `seen` set persists
      // across reconnects (see CatchUpBuffer).
      this.buffer.beginCatchUp();
      this.sendFetchRequest(this.watermark);
    } else if (type === 'fetch_messages_response') {
      const rows: SessionMessageBody[] = Array.isArray(frame.rows) ? frame.rows : [];
      // The server caps a page at WS_FETCH_PAGE_LIMIT (200) and sets has_more
      // for the rest. Continue from the last row with a strict (created_at, id)
      // cursor; without this the remainder waits for the next reconnect.
      //
      // Only treat the page as partial if we can actually build that cursor: an
      // empty page would page forever on an unmoving cursor, and a row missing
      // either field gives nothing to page from. In both cases ending the
      // catch-up is the safe move — leaving it open with no follow-up request
      // in flight would buffer every live message for the rest of the
      // connection and never release them.
      const last = rows[rows.length - 1];
      const nextCursor = frame.has_more === true && last?.created_at && last?.id
        ? { created_at: last.created_at, id: last.id }
        : null;
      this.deliver(this.buffer.completeFetch(rows, nextCursor !== null));
      if (nextCursor) {
        this.sendFetchRequest(nextCursor);
      }
    } else if (type === 'resync_required') {
      // The cursor is unservable — drop it and re-fetch the tail.
      this.log('info', `Session WS resync required: ${frame.reason ?? 'unknown'}`);
      this.watermark = null;
      this.buffer.beginCatchUp();
      this.sendFetchRequest(null);
    } else if (type === 'update') {
      const body: SessionMessageBody = frame.payload?.body ?? {};
      if (body.t === 'new-message') {
        this.deliver(this.buffer.bufferLive(body));
      }
    }
  }

  private sendFetchRequest(after: FetchCursor | null): void {
    this.send({
      type: 'fetch_messages_request',
      request_id: CATCH_UP_REQUEST_ID,
      instance_id: this.instanceId,
      after,
    });
  }

  private deliver(bodies: SessionMessageBody[]): void {
    const contents: string[] = [];
    for (const body of bodies) {
      // Advance the watermark for every delivered body (incl. any AGENT rows on
      // a user-scoped path) so a reconnect doesn't re-fetch them; only USER
      // messages with content are forwarded to the agent, matching the old
      // poller's `sender_type === 'USER'` contract.
      this.advanceWatermark(body);
      if (body.sender_type === 'USER' && body.content) {
        contents.push(body.content);
      }
    }
    if (contents.length === 0) {
      return;
    }

    // Hand messages to the callback strictly in order, one at a time. The
    // handler drives the TUI as appendPrompt()+submitPrompt(), so two
    // overlapping calls interleave into a single scrambled prompt followed by
    // an empty one — which is exactly what a multi-row catch-up produces. A
    // blocking receive loop would get this ordering for free; an event-driven
    // one has to enforce it, and it must span frames as well as rows, since a
    // live `update` can land while an earlier row is still being submitted.
    this.deliveryChain = this.deliveryChain.then(async () => {
      for (const content of contents) {
        try {
          await this.onUserMessage(content);
        } catch (error) {
          this.log('warn', `Session WS onUserMessage handler threw: ${error}`);
        }
      }
    });
  }

  private advanceWatermark(body: SessionMessageBody): void {
    const createdAt = body.created_at;
    if (createdAt === undefined) {
      return;
    }
    if (this.watermark === null || createdAt > this.watermark.created_at) {
      this.watermark = { created_at: createdAt };
    }
  }

  // ------------------------------------------------------------------
  // Low-level helpers
  // ------------------------------------------------------------------

  private send(frame: unknown): void {
    const socket = this.socket;
    if (!socket || socket.readyState !== socket.OPEN) {
      return;
    }
    try {
      socket.send(JSON.stringify(frame));
    } catch (error) {
      this.log('warn', `Session WS send failed: ${error}`);
    }
  }

  /** (Re)arm the liveness watchdog; called on connect and on every frame. */
  private armLiveness(): void {
    this.clearLivenessTimer();
    this.livenessTimer = setTimeout(() => {
      this.log('warn', `Session WS silent for ${this.livenessTimeoutMs}ms; forcing reconnect`);
      const socket = this.socket;
      // Detach before closing, then drive the reconnect from here rather than
      // waiting on onclose. The link this fires against is typically half-open,
      // so its closing handshake may never get a reply and onclose may never
      // arrive — leaning on it would leave the client wedged forever, silently
      // receiving nothing, which is the exact failure this watchdog exists to
      // catch. Detaching first also means the late onclose (if it does arrive)
      // hits the isCurrent() guard instead of queueing a second reconnect.
      this.socket = null;
      if (socket) {
        try {
          socket.close();
        } catch {
          // best-effort close; the reconnect below is what matters
        }
      }
      if (!this.stopped) {
        this.scheduleReconnect();
      }
    }, this.livenessTimeoutMs);
  }

  private clearLivenessTimer(): void {
    if (this.livenessTimer) {
      clearTimeout(this.livenessTimer);
      this.livenessTimer = null;
    }
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }
}

/**
 * Default WS URL = REST base URL with scheme swap and a `/ws` path.
 *
 * Mirrors `vicoa.utils.derive_ws_url`: production
 * (`https://agents.vicoa.ai` → `wss://agents.vicoa.ai/ws`), the legacy
 * port-8443 hostname (`https://api.vicoa.ai:8443` →
 * `wss://api.vicoa.ai:8443/ws`), and local dev (`http://localhost:8080` →
 * `ws://localhost:8080/ws`). Set `VICOA_WS_URL` to override.
 */
export function deriveWsUrl(baseUrl: string): string {
  if (baseUrl.startsWith('https://')) {
    return `wss://${baseUrl.slice('https://'.length).replace(/\/+$/, '')}/ws`;
  }
  if (baseUrl.startsWith('http://')) {
    return `ws://${baseUrl.slice('http://'.length).replace(/\/+$/, '')}/ws`;
  }
  return baseUrl;
}
