import { EventEmitter } from "eventemitter3"
import { Connection } from "./connection.js"
import { clientLogger, configureLogLevel, CodeError, LogLevel, Status } from "../shared/index.js"
import { createRecordSubscriptions } from "./subscriptions/records.js"
import { createChannelSubscriptions } from "./subscriptions/channels.js"
import { createPresenceSubscriptions } from "./subscriptions/presence.js"
import { createCollectionSubscriptions } from "./subscriptions/collections.js"
import { createRoomSubscriptions } from "./subscriptions/rooms.js"

/**
 * Configuration for a `RealtimeClient`. Every field is optional; sensible defaults are applied.
 *
 * @typedef {Object} RealtimeClientOptions
 * @property {number} [pingTimeout] - Milliseconds to wait for a server ping before counting one as missed; also the idle window the browser activity watchdog uses before probing the connection (default 30000).
 * @property {number} [maxMissedPings] - Number of consecutive missed pings tolerated before the client treats the connection as dead and reconnects (default 1).
 * @property {boolean} [shouldReconnect] - Whether the client automatically reconnects after an unexpected disconnect or missed pings. When false the connection stays offline until you call `connect()` again (default true).
 * @property {number} [reconnectInterval] - Milliseconds to wait between reconnect attempts (default 2000).
 * @property {number} [maxReconnectAttempts] - Maximum number of reconnect attempts before giving up and emitting `reconnectfailed`. Defaults to no limit (default Infinity).
 * @property {number} [logLevel] - Verbosity of the client logger, taken from the `LogLevel` enum (NONE 0, ERROR 1, WARN 2, INFO 3, DEBUG 4). Configuring the client applies this level process-wide (default LogLevel.ERROR).
 */

/**
 * WebSocket client for a `@prsm/realtime` server. Manages a single connection and exposes
 * rooms, presence, pub/sub channels, versioned records, collections, and structured commands.
 * Connects and reconnects on its own, queues commands while offline, and re-subscribes everything
 * after a reconnect. Extends `EventEmitter`, so you can listen for lifecycle events with `on(...)`:
 * `connect`, `reconnect`, `disconnect`, `close`, `error`, `ping`, `latency`, `reconnectfailed`,
 * `republish`, and `message` (every inbound frame).
 */
export class RealtimeClient extends EventEmitter {
  /**
   * @param {string} url - WebSocket server URL to connect to, for example `ws://localhost:3000` or `wss://api.example.com`. Append query parameters such as an auth token here when the server authenticates connections from the URL.
   * @param {RealtimeClientOptions} [opts] - Connection and reconnection settings. See `RealtimeClientOptions`.
   */
  constructor(url, opts = {}) {
    super()
    this.url = url
    this.socket = null
    this.pingTimeout = undefined
    this.missedPings = 0
    this.isReconnecting = false
    this._status = Status.OFFLINE
    this._lastActivityTime = Date.now()
    this._isBrowser = false

    this.connection = new Connection(null)
    this.options = {
      pingTimeout: opts.pingTimeout ?? 30_000,
      maxMissedPings: opts.maxMissedPings ?? 1,
      shouldReconnect: opts.shouldReconnect ?? true,
      reconnectInterval: opts.reconnectInterval ?? 2_000,
      maxReconnectAttempts: opts.maxReconnectAttempts ?? Infinity,
      logLevel: opts.logLevel ?? LogLevel.ERROR,
    }

    configureLogLevel(this.options.logLevel)

    this.recordSubscriptions = new Map()
    this.collectionSubscriptions = new Map()
    this.presenceSubscriptions = new Map()
    this.joinedRooms = new Map()
    this.channelSubscriptions = new Map()

    this._records = createRecordSubscriptions(this)
    this._channels = createChannelSubscriptions(this)
    this._presence = createPresenceSubscriptions(this)
    this._collections = createCollectionSubscriptions(this)
    this._rooms = createRoomSubscriptions(this, this._presence)

    this._setupConnectionEvents()
    this._setupVisibilityHandling()
  }

  /** @returns {string} Current connection status, one of `'online'`, `'connecting'`, `'reconnecting'`, or `'offline'`. */
  get status() { return this._status }
  /** @returns {string|undefined} The server-assigned connection id, or undefined before the first connect completes. A fresh id is assigned after each reconnect. */
  get connectionId() { return this.connection.connectionId }

  /**
   * Subscribe to a versioned record and receive updates as they happen. The callback fires once
   * immediately with the current value, then on every server-side change. In `patch` mode a desync
   * (a version gap) triggers an automatic resubscribe so you never miss state.
   *
   * @param {string} recordId - Identifier of the record to subscribe to. The server must expose a matching record.
   * @param {(update: {recordId: string, full?: any, patch?: import('fast-json-patch').Operation[], version: number, deleted?: boolean}) => void} callback - Invoked with each update. `full` carries the whole document (always set on the initial call and in `full` mode); `patch` carries JSON Patch operations in `patch` mode; `deleted` is true when the record was removed; `version` is the monotonically increasing record version.
   * @param {{mode?: 'full' | 'patch'}} [options] - `mode` selects whether updates ship the whole document (`full`) or JSON Patches (`patch`) (default `'full'`).
   * @returns {Promise<{success: boolean, record: any, version: number}>} Resolves with the subscribe result: whether it succeeded, the current record value, and its version.
   */
  subscribeRecord(recordId, callback, options) { return this._records.subscribe(recordId, callback, options) }
  /**
   * Stop receiving updates for a record.
   *
   * @param {string} recordId - Identifier of the record to unsubscribe from.
   * @returns {Promise<boolean>} Resolves true when the server acknowledged the unsubscribe.
   */
  unsubscribeRecord(recordId) { return this._records.unsubscribe(recordId) }
  /**
   * Write a new value to a record. The server must expose the record as writable. Subscribers
   * receive the change according to their chosen mode.
   *
   * @param {string} recordId - Identifier of the record to write.
   * @param {any} newValue - The new record value.
   * @param {Object} [options] - Server-defined write options forwarded as-is.
   * @returns {Promise<boolean>} Resolves true when the write was accepted.
   */
  writeRecord(recordId, newValue, options) { return this._records.write(recordId, newValue, options) }

  /**
   * Subscribe to a pub/sub channel. The callback fires for each message the server publishes; any
   * backlog requested via `historyLimit` or `since` is delivered first, oldest to newest.
   *
   * @param {string} channel - Name of the channel to subscribe to. The server must expose a matching channel.
   * @param {(message: any) => void} callback - Invoked with each published message, and with each backfilled history message.
   * @param {{historyLimit?: number, since?: string}} [options] - `historyLimit` caps how many past messages to replay on subscribe; `since` replays messages after the given message id or timestamp.
   * @returns {Promise<{success: boolean, history: any[]}>} Resolves with whether the subscribe succeeded and the history that was replayed.
   */
  subscribeChannel(channel, callback, options) { return this._channels.subscribe(channel, callback, options) }
  /**
   * Stop receiving messages from a channel.
   *
   * @param {string} channel - Name of the channel to unsubscribe from.
   * @returns {Promise<any>} Resolves with the server acknowledgement.
   */
  unsubscribeChannel(channel) { return this._channels.unsubscribe(channel) }
  /**
   * Fetch past messages for a channel without subscribing.
   *
   * @param {string} channel - Name of the channel to read history for.
   * @param {{limit?: number, since?: string}} [options] - `limit` caps how many messages to return; `since` returns messages after the given message id or timestamp.
   * @returns {Promise<{success: boolean, history: any[]}>} Resolves with whether the request succeeded and the matching messages, oldest to newest.
   */
  getChannelHistory(channel, options) { return this._channels.getHistory(channel, options) }

  /**
   * Subscribe to presence for a room and receive other members' state. Prefer `joinRoom(name, cb)`
   * when you also need room membership; this method only subscribes to presence updates.
   *
   * @param {string} roomName - Name of the room whose presence to track. The server must track presence for it.
   * @param {(update: {roomName: string, present: string[], states: Object<string, any>, joined?: string, left?: string}) => void} callback - Invoked with each presence change. The first call carries the full snapshot (`present` connection ids and their `states`); later calls carry incremental changes, including `joined`/`left` connection ids.
   * @returns {Promise<{success: boolean, present: string[], states?: Object<string, any>}>} Resolves with the initial presence snapshot.
   */
  subscribePresence(roomName, callback) { return this._presence.subscribe(roomName, callback) }
  /**
   * Stop receiving presence updates for a room.
   *
   * @param {string} roomName - Name of the room to unsubscribe presence from.
   * @returns {Promise<boolean>} Resolves true when the server acknowledged the unsubscribe.
   */
  unsubscribePresence(roomName) { return this._presence.unsubscribe(roomName) }
  /**
   * Publish this connection's presence state into a room. Other members subscribed to the room's
   * presence receive the change.
   *
   * @param {string} roomName - Name of the room to publish state into. You typically join the room first.
   * @param {{state: any, expireAfter?: number, silent?: boolean}} options - `state` is the presence payload to broadcast; `expireAfter` is a time-to-live in milliseconds after which the state is dropped automatically; `silent` updates the stored state without broadcasting an update to other members.
   * @returns {Promise<any>} Resolves with the server acknowledgement.
   */
  publishPresenceState(roomName, options) { return this._presence.publishState(roomName, options) }
  /**
   * Clear this connection's presence state in a room.
   *
   * @param {string} roomName - Name of the room to clear state in.
   * @returns {Promise<any>} Resolves with the server acknowledgement.
   */
  clearPresenceState(roomName) { return this._presence.clearState(roomName) }
  /**
   * Re-fetch the full presence snapshot for a room and feed it to the subscription handler. Useful
   * to reconcile state after a network blip. Does nothing if you are not subscribed to the room.
   *
   * @param {string} roomName - Name of the room to refresh.
   * @returns {Promise<boolean>} Resolves true when the snapshot was fetched and applied.
   */
  forcePresenceUpdate(roomName) { return this._presence.forceUpdate(roomName) }

  /**
   * Subscribe to a collection, an index over records resolved per-connection at subscribe time. The
   * `onDiff` handler fires once immediately with the initial members, then on every membership change.
   *
   * @param {string} collectionId - Identifier of the collection to subscribe to. The server must expose a matching collection.
   * @param {{onDiff?: (diff: {added: Array<{id: string, record: any}>, removed: Array<{id: string, record: any}>, changed: Array<{id: string, record: any}>, version: number}) => void}} [options] - `onDiff` receives membership changes. The initial call reports every current member under `added`; later calls report incremental `added`, `removed`, and `changed` records along with the collection `version`.
   * @returns {Promise<{success: boolean, ids: string[], records: any[], version: number}>} Resolves with the initial members and collection version.
   */
  subscribeCollection(collectionId, options) { return this._collections.subscribe(collectionId, options) }
  /**
   * Stop receiving diffs for a collection.
   *
   * @param {string} collectionId - Identifier of the collection to unsubscribe from.
   * @returns {Promise<boolean>} Resolves true when the server acknowledged the unsubscribe.
   */
  unsubscribeCollection(collectionId) { return this._collections.unsubscribe(collectionId) }

  /**
   * Join a room, scoping membership and broadcasts. Pass `onPresenceUpdate` to also subscribe to
   * the room's presence in one call; omit it to join without tracking presence.
   *
   * @param {string} roomName - Name of the room to join.
   * @param {(update: {roomName: string, present: string[], states: Object<string, any>, joined?: string, left?: string}) => void} [onPresenceUpdate] - Optional presence handler. When provided, this also subscribes to the room's presence; the handler receives the same updates as `subscribePresence`.
   * @returns {Promise<{success: boolean, present: string[]}>} Resolves with whether the join succeeded and the current member connection ids.
   */
  joinRoom(roomName, onPresenceUpdate) { return this._rooms.join(roomName, onPresenceUpdate) }
  /**
   * Leave a room. Any presence subscription established for the room is torn down as well.
   *
   * @param {string} roomName - Name of the room to leave.
   * @returns {Promise<{success: boolean}>} Resolves with whether the leave succeeded.
   */
  leaveRoom(roomName) { return this._rooms.leave(roomName) }
  /**
   * Fetch server-side metadata for a room.
   *
   * @param {string} roomName - Name of the room to read metadata for.
   * @returns {Promise<any>} Resolves with the room metadata, or null on failure.
   */
  getRoomMetadata(roomName) { return this._rooms.getMetadata(roomName) }

  /**
   * Fetch metadata stored on a connection. With no argument it returns this connection's metadata.
   *
   * @param {string} [connectionId] - Connection id to look up. If omitted, returns metadata for the current connection.
   * @returns {Promise<any>} Resolves with the metadata object, or null on failure.
   */
  async getConnectionMetadata(connectionId) {
    try {
      if (connectionId) {
        const result = await this.command("rt/get-connection-metadata", { connectionId })
        return result.metadata
      }
      const result = await this.command("rt/get-my-connection-metadata")
      return result.metadata
    } catch (error) {
      clientLogger.error("failed to get metadata for connection", { err: error })
      return null
    }
  }

  /**
   * Set metadata on the current connection. The metadata is re-applied automatically after a
   * reconnect, since a reconnect produces a fresh server-side connection.
   *
   * @param {any} metadata - The metadata value to store for this connection.
   * @param {Object} [options] - Server-defined options forwarded as-is.
   * @returns {Promise<boolean>} Resolves true when the metadata was stored.
   */
  async setConnectionMetadata(metadata, options) {
    try {
      const result = await this.command("rt/set-my-connection-metadata", { metadata, options })
      return result.success
    } catch (error) {
      clientLogger.error("failed to set metadata for connection", { err: error })
      return false
    }
  }

  /**
   * Atomically commit a batch of record mutations on the server. Either every
   * operation lands or none do; a failed batch rejects rather than partially
   * applying. Requires the server to expose each record as writable. Ops look
   * like `{ op: 'write', recordId, value, options? }` or
   * `{ op: 'delete', recordId }`. Each record may appear once. The batch holds record locks on
   * the touched records, so concurrent batches on the same records serialize.
   * The server also accepts `server.transaction(fn, { records })` for
   * multi-step read-compute-write transactions under the same lock.
   *
   * @param {Array<{op: 'write'|'delete', recordId: string, value?: any, options?: Object}>} operations
   * @returns {Promise<{id: string, results: Array<{op: 'write'|'delete', recordId: string, success: boolean, version: number}>}>} Resolves with the transaction id and per-record outcomes when the batch committed atomically.
   */
  async transaction(operations) {
    if (!Array.isArray(operations) || operations.length === 0) {
      throw new CodeError("Transaction requires a non-empty array of operations", "ETXN", "TransactionError")
    }
    const result = await this.command("rt/transaction", { operations })
    if (result && typeof result === "object" && result.error) {
      throw new CodeError(result.error, result.code || "ETXN", result.name || "TransactionError")
    }
    return result
  }

  _setupConnectionEvents() {
    this.connection.on("message", (data) => {
      this.emit("message", data)

      if (data.command === "rt/record-update") this._records.handleUpdate(data.payload)
      else if (data.command === "rt/record-deleted") this._records.handleDeleted(data.payload)
      else if (data.command === "rt/presence-update") this._presence.handleUpdate(data.payload)
      else if (data.command === "rt/subscription-message") this._channels.handleMessage(data.payload)
      else if (data.command === "rt/collection-diff") this._collections.handleDiff(data.payload)
      else {
        const systemCommands = ["ping", "pong", "latency", "latency:request", "latency:response"]
        if (data.command && !systemCommands.includes(data.command)) {
          this.emit(data.command, data.payload)
        }
      }
    })

    this.connection.on("close", () => {
      this._status = Status.OFFLINE
      this.emit("close")
      this.reconnect()
    })

    this.connection.on("error", (error) => this.emit("error", error))
    this.connection.on("ping", () => { this._heartbeat(); this.emit("ping") })
    this.connection.on("latency", (data) => this.emit("latency", data))
  }

  _setupVisibilityHandling() {
    try {
      this._isBrowser = !!globalThis.document && typeof globalThis.document.addEventListener === "function"
      if (!this._isBrowser) return

      setInterval(() => this._checkActivity(), 10000)

      try {
        const doc = globalThis.document
        const events = ["mousedown", "keydown", "touchstart", "visibilitychange"]
        events.forEach((eventName) => {
          doc.addEventListener(eventName, () => {
            this._lastActivityTime = Date.now()
            if (eventName === "visibilitychange" && doc.visibilityState === "visible") {
              if (this._status === Status.OFFLINE) return
              this.command("rt/noop", {}, 5000)
                .then(() => { clientLogger.info("tab visible, connection ok"); this.emit("republish") })
                .catch(() => { clientLogger.info("tab visible, forcing reconnect"); this._forceReconnect() })
            }
          })
        })
      } catch {}
    } catch {}
  }

  _checkActivity() {
    if (!this._isBrowser) return
    const now = Date.now()
    const timeSinceActivity = now - this._lastActivityTime
    if (timeSinceActivity > this.options.pingTimeout && this._status === Status.ONLINE) {
      this.command("rt/noop", {}, 5000).catch(() => {
        clientLogger.info("no activity, forcing reconnect", { timeSinceActivity })
        this._forceReconnect()
      })
    }
    if (this._status === Status.ONLINE) this._lastActivityTime = now
  }

  _forceReconnect() {
    if (this.isReconnecting) return
    if (this.socket) { try { this.socket.close() } catch {} }
    this._status = Status.OFFLINE
    this.connection.socket = null
    this.connection.status = Status.OFFLINE
    this.reconnect()
  }

  /**
   * Open the WebSocket connection. Resolves once the connection is online and the server has
   * assigned a connection id. Safe to call when already online (resolves immediately) or mid-connect
   * (waits for the in-flight attempt). Commands sent while offline trigger a connect automatically,
   * so calling this explicitly is optional.
   *
   * @returns {Promise<void>} Resolves when the connection is online; rejects if the attempt errors.
   */
  connect() {
    if (this._status === Status.ONLINE) return Promise.resolve()

    if (this._status === Status.CONNECTING || this._status === Status.RECONNECTING) {
      return new Promise((resolve, reject) => {
        const onConnect = () => { this.removeListener("connect", onConnect); this.removeListener("error", onError); resolve() }
        const onError = (error) => { this.removeListener("connect", onConnect); this.removeListener("error", onError); reject(error) }
        this.once("connect", onConnect)
        this.once("error", onError)
      })
    }

    this._status = Status.CONNECTING
    this._closed = false
    return new Promise((resolve, reject) => {
      try {
        this.socket = new WebSocket(this.url)
        this.socket.onopen = () => {
          this._status = Status.ONLINE
          this.connection.socket = this.socket
          this.connection.status = Status.ONLINE
          this.connection.applyListeners()
          this._heartbeat()

          if (this.connection.connectionId) {
            this.emit("connect")
            resolve()
          } else {
            const onId = () => { this.connection.removeListener("id-assigned", onId); this.emit("connect"); resolve() }
            this.connection.once("id-assigned", onId)
          }
        }
        this.socket.onerror = () => {
          this._status = Status.OFFLINE
          reject(new CodeError("WebSocket connection error", "ECONNECTION", "ConnectionError"))
        }
      } catch (error) {
        this._status = Status.OFFLINE
        reject(error)
      }
    })
  }

  _heartbeat() {
    this.missedPings = 0
    if (!this.pingTimeout) {
      this.pingTimeout = setTimeout(() => this._checkPingStatus(), this.options.pingTimeout)
    }
  }

  _checkPingStatus() {
    this.missedPings++
    if (this.missedPings > this.options.maxMissedPings) {
      if (this.options.shouldReconnect) {
        clientLogger.warn("missed pings, reconnecting", { missedPings: this.missedPings })
        this.reconnect()
      }
    } else {
      this.pingTimeout = setTimeout(() => this._checkPingStatus(), this.options.pingTimeout)
    }
  }

  /**
   * Close the connection intentionally and stop automatic reconnection. Emits `disconnect` once the
   * socket is closed. Use this for a deliberate teardown; for transient drops the client reconnects
   * on its own.
   *
   * @returns {Promise<void>} Resolves once the connection is fully closed.
   */
  close() {
    this._closed = true
    if (this._status === Status.OFFLINE) return Promise.resolve()

    return new Promise((resolve) => {
      const onClose = () => {
        this.removeListener("close", onClose)
        this._status = Status.OFFLINE
        this.emit("disconnect")
        resolve()
      }
      this.once("close", onClose)
      clearTimeout(this.pingTimeout)
      this.pingTimeout = undefined
      if (this.socket) this.socket.close()
    })
  }

  /**
   * Begin reconnecting after a drop. The client calls this on its own when the socket closes or
   * pings are missed; you rarely call it directly. No-op when reconnection is disabled, a reconnect
   * is already in progress, or the connection was closed deliberately via `close()`. Emits
   * `reconnectfailed` once `maxReconnectAttempts` is exhausted.
   *
   * @returns {void}
   */
  reconnect() {
    if (this._closed || !this.options.shouldReconnect || this.isReconnecting) return

    this._status = Status.RECONNECTING
    this.isReconnecting = true
    clearTimeout(this.pingTimeout)
    this.pingTimeout = undefined
    this.missedPings = 0

    if (this.socket) {
      try { this.socket.close() } catch {}
      this.emit("disconnect")
    }

    let attempt = 1
    const connect = () => {
      this.socket = new WebSocket(this.url)
      this.socket.onerror = () => {
        attempt++
        if (attempt <= this.options.maxReconnectAttempts) {
          setTimeout(connect, this.options.reconnectInterval)
          return
        }
        this.isReconnecting = false
        this._status = Status.OFFLINE
        this.emit("reconnectfailed")
      }
      this.socket.onopen = () => {
        this.isReconnecting = false
        this._status = Status.ONLINE
        this.connection.socket = this.socket
        this.connection.status = Status.ONLINE
        this.connection.applyListeners(true)
        this._heartbeat()

        const finish = async () => {
          await this._resubscribeAll()
          this.emit("connect")
          this.emit("reconnect")
        }

        if (this.connection.connectionId) {
          finish()
        } else {
          const onId = () => { this.connection.removeListener("id-assigned", onId); finish() }
          this.connection.once("id-assigned", onId)
        }
      }
    }
    connect()
  }

  /**
   * Invoke a structured command on the server and await its response, the client side of the
   * request/response RPC. If the client is offline it connects first, then sends the command.
   *
   * @param {string} command - Name of the server-exposed command to invoke.
   * @param {Object} [payload] - Arguments passed to the command handler.
   * @param {number} [expiresIn] - Milliseconds to wait for a response before the call rejects with a timeout (default 30000).
   * @returns {Promise<any>} Resolves with the value returned by the command handler.
   */
  async command(command, payload, expiresIn = 30000) {
    if (this._status !== Status.ONLINE) {
      return this.connect().then(() => this.connection.command(command, payload, expiresIn))
    }
    return this.connection.command(command, payload, expiresIn)
  }

  async _resubscribeAll() {
    clientLogger.info("resubscribing to all subscriptions after reconnect")
    try {
      const successfulRooms = await this._rooms.resubscribe()
      await Promise.allSettled([
        ...Array.from(this._records.resubscribe()),
        ...Array.from(this._channels.resubscribe()),
        ...Array.from(this._collections.resubscribe()),
      ].flat())

      if (successfulRooms.length > 0) {
        for (const roomName of successfulRooms) {
          try { await this._presence.forceUpdate(roomName) }
          catch (err) { clientLogger.error("error refreshing presence for room", { roomName, err }) }
          await new Promise((resolve) => setTimeout(resolve, 50))
        }
      }
    } catch (error) {
      clientLogger.error("error during resubscription", { err: error })
    }
  }
}
