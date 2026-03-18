import { EventEmitter } from "eventemitter3"
import { Connection } from "./connection.js"
import { clientLogger, CodeError, LogLevel, Status } from "../shared/index.js"
import { createRecordSubscriptions } from "./subscriptions/records.js"
import { createChannelSubscriptions } from "./subscriptions/channels.js"
import { createPresenceSubscriptions } from "./subscriptions/presence.js"
import { createCollectionSubscriptions } from "./subscriptions/collections.js"
import { createRoomSubscriptions } from "./subscriptions/rooms.js"

/**
 * @typedef {Object} RealtimeClientOptions
 * @property {number} [pingTimeout] - ms before a ping is considered missed (default 30000)
 * @property {number} [maxMissedPings] - missed pings before reconnect (default 1)
 * @property {boolean} [shouldReconnect] - auto-reconnect on disconnect (default true)
 * @property {number} [reconnectInterval] - ms between reconnect attempts (default 2000)
 * @property {number} [maxReconnectAttempts] - max reconnect attempts (default Infinity)
 * @property {number} [logLevel] - log level from LogLevel enum
 */

export class RealtimeClient extends EventEmitter {
  /**
   * @param {string} url - websocket server URL
   * @param {RealtimeClientOptions} [opts]
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

    clientLogger.configure({ level: this.options.logLevel, styling: true })

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

  /** @returns {string} current connection status */
  get status() { return this._status }
  /** @returns {string|undefined} the server-assigned connection id */
  get connectionId() { return this.connection.connectionId }

  /**
   * @param {string} recordId
   * @param {(update: {recordId: string, full?: any, patch?: import('fast-json-patch').Operation[], version: number, deleted?: boolean}) => void} callback
   * @param {{mode?: 'full' | 'patch'}} [options]
   * @returns {Promise<{success: boolean, record: any, version: number}>}
   */
  subscribeRecord(recordId, callback, options) { return this._records.subscribe(recordId, callback, options) }
  /**
   * @param {string} recordId
   * @returns {Promise<boolean>}
   */
  unsubscribeRecord(recordId) { return this._records.unsubscribe(recordId) }
  /**
   * @param {string} recordId
   * @param {any} newValue
   * @param {Object} [options]
   * @returns {Promise<boolean>}
   */
  writeRecord(recordId, newValue, options) { return this._records.write(recordId, newValue, options) }

  /**
   * @param {string} channel
   * @param {(message: any) => void} callback
   * @param {{historyLimit?: number, since?: string}} [options]
   * @returns {Promise<{success: boolean, history: any[]}>}
   */
  subscribeChannel(channel, callback, options) { return this._channels.subscribe(channel, callback, options) }
  /**
   * @param {string} channel
   * @returns {Promise<any>}
   */
  unsubscribeChannel(channel) { return this._channels.unsubscribe(channel) }
  /**
   * @param {string} channel
   * @param {{limit?: number, since?: string}} [options]
   * @returns {Promise<{success: boolean, history: any[]}>}
   */
  getChannelHistory(channel, options) { return this._channels.getHistory(channel, options) }

  /**
   * @param {string} roomName
   * @param {(update: {roomName: string, present: string[], states: Object<string, any>, joined?: string, left?: string}) => void} callback
   * @returns {Promise<{success: boolean, present: string[], states?: Object<string, any>}>}
   */
  subscribePresence(roomName, callback) { return this._presence.subscribe(roomName, callback) }
  /**
   * @param {string} roomName
   * @returns {Promise<boolean>}
   */
  unsubscribePresence(roomName) { return this._presence.unsubscribe(roomName) }
  /**
   * @param {string} roomName
   * @param {{state: any, expireAfter?: number, silent?: boolean}} options
   * @returns {Promise<any>}
   */
  publishPresenceState(roomName, options) { return this._presence.publishState(roomName, options) }
  /**
   * @param {string} roomName
   * @returns {Promise<any>}
   */
  clearPresenceState(roomName) { return this._presence.clearState(roomName) }
  /**
   * @param {string} roomName
   * @returns {Promise<boolean>}
   */
  forcePresenceUpdate(roomName) { return this._presence.forceUpdate(roomName) }

  /**
   * @param {string} collectionId
   * @param {{onDiff?: (diff: {added: Array<{id: string, record: any}>, removed: Array<{id: string, record: any}>, changed: Array<{id: string, record: any}>, version: number}) => void}} [options]
   * @returns {Promise<{success: boolean, ids: string[], records: any[], version: number}>}
   */
  subscribeCollection(collectionId, options) { return this._collections.subscribe(collectionId, options) }
  /**
   * @param {string} collectionId
   * @returns {Promise<boolean>}
   */
  unsubscribeCollection(collectionId) { return this._collections.unsubscribe(collectionId) }

  /**
   * @param {string} roomName
   * @param {(update: {roomName: string, present: string[], states: Object<string, any>, joined?: string, left?: string}) => void} [onPresenceUpdate]
   * @returns {Promise<{success: boolean, present: string[]}>}
   */
  joinRoom(roomName, onPresenceUpdate) { return this._rooms.join(roomName, onPresenceUpdate) }
  /**
   * @param {string} roomName
   * @returns {Promise<{success: boolean}>}
   */
  leaveRoom(roomName) { return this._rooms.leave(roomName) }
  /**
   * @param {string} roomName
   * @returns {Promise<any>}
   */
  getRoomMetadata(roomName) { return this._rooms.getMetadata(roomName) }

  /**
   * @param {string} [connectionId] - if omitted, returns metadata for the current connection
   * @returns {Promise<any>}
   */
  async getConnectionMetadata(connectionId) {
    try {
      if (connectionId) {
        const result = await this.command("mesh/get-connection-metadata", { connectionId })
        return result.metadata
      }
      const result = await this.command("mesh/get-my-connection-metadata")
      return result.metadata
    } catch (error) {
      clientLogger.error(`Failed to get metadata for connection:`, error)
      return null
    }
  }

  /**
   * @param {any} metadata
   * @param {Object} [options]
   * @returns {Promise<boolean>}
   */
  async setConnectionMetadata(metadata, options) {
    try {
      const result = await this.command("mesh/set-my-connection-metadata", { metadata, options })
      return result.success
    } catch (error) {
      clientLogger.error(`Failed to set metadata for connection:`, error)
      return false
    }
  }

  _setupConnectionEvents() {
    this.connection.on("message", (data) => {
      this.emit("message", data)

      if (data.command === "mesh/record-update") this._records.handleUpdate(data.payload)
      else if (data.command === "mesh/record-deleted") this._records.handleDeleted(data.payload)
      else if (data.command === "mesh/presence-update") this._presence.handleUpdate(data.payload)
      else if (data.command === "mesh/subscription-message") this._channels.handleMessage(data.payload)
      else if (data.command === "mesh/collection-diff") this._collections.handleDiff(data.payload)
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
              this.command("mesh/noop", {}, 5000)
                .then(() => { clientLogger.info("Tab visible, connection ok"); this.emit("republish") })
                .catch(() => { clientLogger.info("Tab visible, forcing reconnect"); this._forceReconnect() })
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
      this.command("mesh/noop", {}, 5000).catch(() => {
        clientLogger.info(`No activity for ${timeSinceActivity}ms, forcing reconnect`)
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

  /** @returns {Promise<void>} */
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
        clientLogger.warn(`Missed ${this.missedPings} pings, reconnecting...`)
        this.reconnect()
      }
    } else {
      this.pingTimeout = setTimeout(() => this._checkPingStatus(), this.options.pingTimeout)
    }
  }

  /** @returns {Promise<void>} */
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
   * @param {string} command - command name
   * @param {Object} [payload] - command payload
   * @param {number} [expiresIn] - timeout in ms (default 30000)
   * @returns {Promise<any>}
   */
  async command(command, payload, expiresIn = 30000) {
    if (this._status !== Status.ONLINE) {
      return this.connect().then(() => this.connection.command(command, payload, expiresIn))
    }
    return this.connection.command(command, payload, expiresIn)
  }

  async _resubscribeAll() {
    clientLogger.info("Resubscribing to all subscriptions after reconnect")
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
          catch (err) { clientLogger.error(`Error refreshing presence for room ${roomName}:`, err) }
          await new Promise((resolve) => setTimeout(resolve, 50))
        }
      }
    } catch (error) {
      clientLogger.error("Error during resubscription:", error)
    }
  }
}
