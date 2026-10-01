/**
 * A minimal Chrome DevTools Protocol client built directly on `ws`.
 *
 * Why a hand-rolled CDP client instead of `chrome-remote-interface` or
 * Puppeteer: this plugin ships as a DSH Host bundle, and every dependency it
 * declares is a dependency every installing user must resolve. CDP itself is a
 * JSON-RPC-over-WebSocket protocol, so the only non-negotiable runtime
 * dependency is a WebSocket implementation — `ws`, which the DSH runtime
 * already carries. Everything above the transport (target management, page
 * state, input synthesis) belongs in `driver.ts`, where it can be reasoned
 * about as browser state rather than as protocol plumbing.
 *
 * The client is deliberately flat-mode aware (`Target.attachToTarget
 * { flatten: true }`): every page command carries an explicit `sessionId`, so
 * one socket multiplexes every tab and there is no per-target socket to leak.
 *
 * @module dsh-sidebrowser/browser/cdp-client
 */

import { WebSocket } from 'ws'

/**
 * JSON value as CDP itself models it. CDP payloads are plain JSON, so the
 * client speaks in `unknown` at its boundary and narrows at each call site
 * rather than pretending to know every domain's shape up front.
 */
export type CdpValue = unknown

/** A CDP command name, for example `Page.navigate` or `Target.createTarget`. */
export type CdpMethod = string

/** One CDP command envelope: method, optional params, optional flat session. */
export interface CdpRequest {
  /** Command name; CDP routes it by domain prefix. */
  method: CdpMethod
  /** Domain-specific parameters; omitted commands take no params. */
  params?: Record<string, CdpValue>
  /**
   * Flat-mode session id. Required for every command addressed at a page;
   * omitted for browser-level commands such as `Target.createTarget`.
   */
  sessionId?: string
}

/** One decoded CDP event: a method name plus its params. */
export interface CdpEvent {
  /** Event name; CDP names events `<Domain>.<event>`. */
  method: CdpMethod
  /** Event payload, or an empty object when the event carries none. */
  params: Record<string, CdpValue>
}

/** Handler invoked for each CDP event; errors are caught and reported, never rethrown into the socket. */
export type CdpEventHandler = (event: CdpEvent) => void

/** Called when the socket closes or errors; receives the reason if one was provided. */
export type CdpCloseHandler = (reason: string | undefined) => void

/** A page target the driver can attach to and drive. */
export interface CdpTarget {
  /** CDP target id, stable for the life of the page. */
  targetId: string
  /** Target type; the driver only opens `page` targets. */
  type: string
  /** Current page URL as Chrome reports it (about:blank before the first navigation). */
  url: string
  /** Page title, often empty for a page that has not finished loading. */
  title: string
}

/** Options for {@link CdpClient.connect}. */
export interface CdpConnectOptions {
  /**
   * How long one command may stay unanswered before the client rejects it.
   * A wedged page (a modal dialog, a frozen renderer) must not hold a Host tool
   * call open indefinitely, so every command is bounded and the failure is
   * reported to the caller instead of hanging the session.
   */
  timeoutMs?: number
  /**
   * Largest accepted single CDP message. Chrome sends whole `Page.captureScreenshot`
   * payloads (base64 PNGs, easily megabytes) as one frame, so the default is
   * generous; anything larger is treated as a protocol violation and closes
   * the socket rather than growing the Host's heap without bound.
   */
  maxMessageBytes?: number
}

/** Default per-command budget: long enough for a slow navigation, short enough to fail visibly. */
const DEFAULT_TIMEOUT_MS = 30_000

/** Default accepted CDP frame size: 64 MiB, far above any screenshot we request. */
const DEFAULT_MAX_MESSAGE_BYTES = 64 * 1024 * 1024

/** A command that was answered with `error` rather than `result`. */
export class CdpError extends Error {
  /**
   * @param method - the command that failed.
   * @param code - CDP's numeric error code.
   * @param message - CDP's human-readable failure message.
   * @param data - any extra failure detail CDP attached.
   */
  constructor(
    /** The command that failed. */ readonly method: CdpMethod,
    /** CDP's numeric error code. */ readonly code: number,
    message: string,
    /** Extra failure detail CDP attached, when present. */ readonly data?: CdpValue,
  ) {
    super(`${method} failed (${code}): ${message}`)
    this.name = 'CdpError'
  }
}

/** A command that exceeded its time budget or lost its connection. */
export class CdpTimeoutError extends Error {
  /**
   * @param method - the command that timed out.
   * @param timeoutMs - the budget that elapsed.
   */
  constructor(
    /** The command that timed out. */ readonly method: CdpMethod,
    /** The budget that elapsed, in milliseconds. */ readonly timeoutMs: number,
  ) {
    super(`${method} timed out after ${timeoutMs}ms`)
    this.name = 'CdpTimeoutError'
  }
}

/** Raised when a command is issued on a client whose socket is no longer open. */
export class CdpClosedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CdpClosedError'
  }
}

/** One in-flight command, resolved or rejected when its reply arrives. */
interface PendingCommand {
  readonly method: CdpMethod
  readonly resolve: (result: CdpValue) => void
  readonly reject: (error: Error) => void
  timer: NodeJS.Timeout
}

/** Decoder for the JSON payloads CDP frames. Shared so every parse path is identical. */
function decodeMessage(data: unknown): { id?: number, method?: CdpMethod, params?: Record<string, CdpValue>, result?: CdpValue, error?: { code: number, message: string, data?: CdpValue } } {
  const text = typeof data === 'string' ? data : Buffer.isBuffer(data) ? data.toString('utf8') : String(data)
  const parsed: unknown = JSON.parse(text)
  if (typeof parsed !== 'object' || parsed === null) throw new Error('CDP frame is not an object')
  return parsed as { id?: number, method?: CdpMethod, params?: Record<string, CdpValue>, result?: CdpValue, error?: { code: number, message: string, data?: CdpValue } }
}

/**
 * A connected CDP session over one WebSocket.
 *
 * One instance owns one socket and multiplexes every command and event over
 * it. Commands are correlated by a monotonic integer id; events are fanned out
 * to registered handlers. Disposal closes the socket, rejects every in-flight
 * command, and drops every handler, so a disposed client leaves nothing running
 * in the Host process.
 */
export class CdpClient {
  /** The live socket, or undefined before connect and after dispose. */
  private socket: WebSocket | undefined

  /** Next command id; CDP ids only need to be unique per connection. */
  private nextId = 1

  /** In-flight commands keyed by their protocol id. */
  private readonly pending = new Map<number, PendingCommand>()

  /** Event handlers keyed by CDP method name; `'*'` receives every event. */
  private readonly handlers = new Map<CdpMethod, Set<CdpEventHandler>>()

  /** The close handler, invoked once when the socket closes or errors. */
  private onClose: CdpCloseHandler | undefined

  /** Set once {@link dispose} has run, so late sends fail with a clear reason. */
  private disposed = false

  /**
   * @param timeoutMs - per-command budget; see {@link CdpConnectOptions.timeoutMs}.
   * @param maxMessageBytes - largest accepted CDP frame; see {@link CdpConnectOptions.maxMessageBytes}.
   */
  private constructor(
    /** Per-command budget in milliseconds. */ private readonly timeoutMs: number = DEFAULT_TIMEOUT_MS,
    /** Largest accepted single CDP frame in bytes. */ private readonly maxMessageBytes: number = DEFAULT_MAX_MESSAGE_BYTES,
  ) {}

  /**
   * Open a CDP session against an already-listening browser endpoint.
   *
   * The caller is responsible for having launched the browser with a debugging
   * port; this method only speaks the protocol. A rejected connection is turned
   * into a thrown error rather than a silent no-op, so a launch race surfaces
   * immediately at the call site.
   * @param webSocketDebuggerUrl - the browser-level `webSocketDebuggerUrl` from `/json/version`.
   * @param options - transport budgets.
   * @returns the connected client, ready for commands.
   */
  static async connect(webSocketDebuggerUrl: string, options: CdpConnectOptions = {}): Promise<CdpClient> {
    const client = new CdpClient(options.timeoutMs ?? DEFAULT_TIMEOUT_MS, options.maxMessageBytes ?? DEFAULT_MAX_MESSAGE_BYTES)
    const socket = new WebSocket(webSocketDebuggerUrl, { perMessageDeflate: false, maxPayload: client.maxMessageBytes })
    await new Promise<void>((resolve, reject) => {
      const onOpen = (): void => {
        socket.off('error', onError)
        resolve()
      }
      const onError = (error: Error): void => {
        socket.off('open', onOpen)
        reject(error)
      }
      socket.once('open', onOpen)
      socket.once('error', onError)
    })
    client.attach(socket)
    return client
  }

  /**
   * Begin routing this client's protocol over an open socket.
   *
   * Split out from {@link connect} so the socket listeners are installed in one
   * place regardless of how the socket came to exist.
   * @param socket - an already-open `ws` socket.
   */
  private attach(socket: WebSocket): void {
    this.socket = socket
    socket.on('message', (data: unknown) => { this.handleFrame(data) })
    socket.on('close', (code: number, reason: Buffer) => {
      const text = reason.length > 0 ? reason.toString('utf8') : undefined
      this.settleAll(`CDP connection closed (${code})`)
      this.onClose?.(text)
    })
    socket.on('error', (error: Error) => {
      this.settleAll(`CDP connection error: ${error.message}`)
      this.onClose?.(error.message)
    })
  }

  /**
   * Route one inbound frame: a reply to a pending command, or an event.
   *
   * A malformed frame closes the socket rather than being skipped. CDP replies
   * and events share one stream, so a frame that cannot be parsed means the
   * stream is out of sync; continuing would risk attributing an event to the
   * wrong command.
   * @param data - the raw WebSocket frame payload.
   */
  private handleFrame(data: unknown): void {
    let frame: ReturnType<typeof decodeMessage>
    try {
      frame = decodeMessage(data)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.socket?.close(1002, `undecodable CDP frame: ${message.slice(0, 120)}`)
      return
    }
    if (frame.id !== undefined) {
      const pending = this.pending.get(frame.id)
      if (pending === undefined) return
      this.pending.delete(frame.id)
      clearTimeout(pending.timer)
      if (frame.error !== undefined) {
        pending.reject(new CdpError(pending.method, frame.error.code, frame.error.message, frame.error.data))
      } else {
        pending.resolve(frame.result ?? {})
      }
      return
    }
    if (typeof frame.method !== 'string') return
    const event: CdpEvent = { method: frame.method, params: frame.params ?? {} }
    for (const handler of this.handlers.get(event.method) ?? []) this.invokeHandler(handler, event)
    for (const handler of this.handlers.get('*') ?? []) this.invokeHandler(handler, event)
  }

  /**
   * Invoke one event handler, isolating its failure.
   *
   * A handler is third-party code from the socket's point of view: one that
   * throws must not prevent the remaining handlers from seeing the event, nor
   * tear down the shared connection.
   * @param handler - the handler to invoke.
   * @param event - the event being dispatched.
   */
  private invokeHandler(handler: CdpEventHandler, event: CdpEvent): void {
    try {
      handler(event)
    } catch (error) {
      // Deliberately swallowed: the only reporter available here is the
      // process console, and a noisy CDP handler must not break navigation.
      console.warn('[dsh-sidebrowser] CDP event handler threw:', error)
    }
  }

  /**
   * Reject every in-flight command, used when the socket dies.
   *
   * Without this the driver's `await` on a command would hang until the process
   * exits, which for a Host plugin means a wedged agent turn.
   * @param reason - the failure text handed to each pending rejection.
   */
  private settleAll(reason: string): void {
    for (const [, pending] of this.pending) {
      clearTimeout(pending.timer)
      pending.reject(new CdpClosedError(reason))
    }
    this.pending.clear()
  }

  /**
   * Register a handler for one CDP method, or for `'*'` to receive all events.
   *
   * Page-lifecycle tracking (navigations, load completion, dialogs) is
   * event-driven, so the driver registers wide handlers rather than polling
   * page state.
   * @param method - a CDP method name, or `'*'` for every event.
   * @param handler - the handler to register.
   * @returns a disposer removing this handler.
   */
  on(method: CdpMethod, handler: CdpEventHandler): () => void {
    const set = this.handlers.get(method) ?? new Set<CdpEventHandler>()
    set.add(handler)
    this.handlers.set(method, set)
    return () => {
      set.delete(handler)
      if (set.size === 0) this.handlers.delete(method)
    }
  }

  /**
   * Register the single close/error handler.
   *
   * Only one is retained: the driver uses it to invalidate its session and
   * schedule a relaunch, and there is only ever one such reaction.
   * @param handler - invoked with the failure reason when the socket ends.
   */
  setCloseHandler(handler: CdpCloseHandler): void {
    this.onClose = handler
  }

  /**
   * Send one command and await its result.
   *
   * Every command is bounded by the client's timeout and by the socket's life,
   * so this either resolves with a decoded result or rejects with a typed
   * error the caller can present to a user.
   * @param method - the CDP command name.
   * @param params - domain-specific parameters.
   * @param sessionId - flat-mode session id, for a command addressed at one page.
   * @returns the decoded `result` object (empty when the command returns none).
   */
  async send(method: CdpMethod, params?: Record<string, CdpValue>, sessionId?: string): Promise<CdpValue> {
    if (this.disposed) throw new CdpClosedError(`CDP client is disposed (command ${method})`)
    const socket = this.socket
    if (socket === undefined || socket.readyState !== socket.OPEN) {
      throw new CdpClosedError(`CDP connection is not open (command ${method})`)
    }
    const id = this.nextId++
    const envelope: Record<string, CdpValue> = { id, method }
    if (params !== undefined) envelope.params = params
    if (sessionId !== undefined) envelope.sessionId = sessionId
    return await new Promise<CdpValue>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new CdpTimeoutError(method, this.timeoutMs))
      }, this.timeoutMs)
      // Node's timer must not hold the Host process open on its own; the
      // pending map is what keeps the command alive, not the timer.
      timer.unref?.()
      this.pending.set(id, { method, resolve, reject, timer })
      socket.send(JSON.stringify(envelope), (error?: Error | null) => {
        // `ws` invokes this callback with `null` on success and an Error on
        // failure, so the absence of an error is tested by nullish-ness rather
        // than by identity with `undefined`.
        if (error === undefined || error === null) return
        const pending = this.pending.get(id)
        if (pending === undefined) return
        this.pending.delete(id)
        clearTimeout(timer)
        reject(new CdpClosedError(`failed to send ${method}: ${error.message}`))
      })
    })
  }

  /**
   * Send a command and narrow its result to a JSON object.
   *
   * Most CDP commands reply with an object; narrowing once here keeps every
   * caller from re-asserting the same shape.
   * @param method - the CDP command name.
   * @param params - domain-specific parameters.
   * @param sessionId - flat-mode session id, for a command addressed at one page.
   * @returns the `result` as a JSON object.
   */
  async sendObject(method: CdpMethod, params?: Record<string, CdpValue>, sessionId?: string): Promise<Record<string, CdpValue>> {
    const result = await this.send(method, params, sessionId)
    if (typeof result === 'object' && result !== null && !Array.isArray(result)) {
      return result as Record<string, CdpValue>
    }
    return {}
  }

  /**
   * Whether the socket is currently usable.
   *
   * The driver checks this before reusing a client so a browser that died
   * between calls produces a relaunch rather than a protocol error.
   * @returns true when the socket exists and is open.
   */
  get isOpen(): boolean {
    const socket = this.socket
    return !this.disposed && socket !== undefined && socket.readyState === socket.OPEN
  }

  /**
   * Tear the client down: reject in-flight commands, close the socket, drop handlers.
   *
   * Idempotent, because both the driver's own disposal and an unexpected socket
   * death can reach it.
   */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.settleAll('CDP client disposed')
    this.handlers.clear()
    this.onClose = undefined
    const socket = this.socket
    this.socket = undefined
    if (socket !== undefined && (socket.readyState === socket.OPEN || socket.readyState === socket.CONNECTING)) {
      socket.close(1000, 'client disposed')
    }
  }
}