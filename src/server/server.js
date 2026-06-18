import { createServer as createHttpServer } from "node:http"
import { randomUUID } from "node:crypto"
import { WebSocketServer } from "ws"
import { LogLevel, configureLogLevel, Status, serverLogger, parseCommand } from "../shared/index.js"
import { Connection } from "./connection.js"
import { PUB_SUB_CHANNEL_PREFIX } from "./utils/constants.js"
import { ConnectionManager } from "./managers/connections.js"
import { PresenceManager } from "./managers/presence.js"
import { RecordManager } from "./managers/records.js"
import { RoomManager } from "./managers/rooms.js"
import { BroadcastManager } from "./managers/broadcast.js"
import { ChannelManager } from "./managers/channels.js"
import { CommandManager } from "./managers/commands.js"
import { PubSubManager } from "./managers/pubsub.js"
import { RecordSubscriptionManager } from "./managers/record-subscriptions.js"
import { RedisManager } from "./managers/redis.js"
import { InstanceManager } from "./managers/instance.js"
import { CollectionManager } from "./managers/collections.js"
import { PersistenceManager } from "./managers/persistence.js"
import { MessageStream } from "./message-stream.js"

const pendingAuthDataStore = new WeakMap()

/**
 * Connection options forwarded to ioredis. Any ioredis client option is accepted; the
 * fields below are the ones most commonly set. The same options are reused to create the
 * pub and sub clients via `duplicate()`.
 * @typedef {Object} RedisConnectionOptions
 * @property {string} [host] - Redis host (defaults to ioredis default of "127.0.0.1").
 * @property {number} [port] - Redis port (defaults to ioredis default of 6379).
 * @property {number} [db] - Redis logical database index (defaults to 0).
 * @property {string} [password] - Redis auth password, if the server requires one.
 * @property {string} [username] - Redis ACL username, if the server requires one.
 */

/**
 * Per-connection authentication callback invoked during the WebSocket handshake, before
 * the connection is accepted. Return any truthy value to accept the connection; the
 * returned value is stored as the connection's initial metadata and is later readable via
 * `getConnectionMetadata` and `ctx.getMetadata()`. Return `null` or `undefined` to reject
 * with HTTP 401. Throw to reject with a custom status, using `err.code` and `err.message`
 * (defaults to 401 "Unauthorized"). May be async.
 * @callback AuthenticateConnection
 * @param {import('node:http').IncomingMessage} req - The upgrade request, useful for reading headers, cookies, or query string.
 * @returns {any | Promise<any>} Truthy metadata to accept, or `null`/`undefined` to reject.
 */

/**
 * @typedef {Object} RealtimeServerOptions
 * @property {RedisConnectionOptions} redis - Redis connection options (required). One Redis instance coordinates state across all server instances.
 * @property {import('./managers/persistence.js').PersistenceAdapter} [persistence] - Optional persistence adapter (for example from `@prsm/realtime/postgres` or `/sqlite`). Required before calling `enableChannelPersistence` or `enableRecordPersistence`.
 * @property {AuthenticateConnection} [authenticateConnection] - Optional per-connection auth callback run during the handshake. When omitted, all connections are accepted.
 * @property {number} [pingInterval] - Interval in milliseconds between server-to-client ping frames used to detect dead connections (default 30000).
 * @property {number} [latencyInterval] - Interval in milliseconds between latency probes sent to each connection (default 5000).
 * @property {number} [maxMissedPongs] - Number of consecutive missed pongs tolerated before a connection is considered dead and closed (default 1).
 * @property {number} [logLevel] - Logger verbosity, one of the `LogLevel` values (default `LogLevel.ERROR`). Applied process-wide via `configureLogLevel`.
 * @property {boolean} [enablePresenceExpirationEvents] - Whether to enable Redis keyspace notifications so expiring presence states emit leave events (default true). Requires the Redis server to permit `CONFIG SET notify-keyspace-events`.
 * @property {import('@prsm/trace').Tracer} [tracer] - Optional `@prsm/trace` tracer. When set, command handlers, record writes, and channel publishes become spans in the active trace.
 */

/** @typedef {string | RegExp} ChannelPattern */

/**
 * Context passed to every command handler and middleware. Carries the originating
 * connection, the parsed command name and payload, and helpers for reading or writing the
 * connection's metadata.
 * @typedef {import('./context.js').Context} Context
 */

/**
 * Distributed WebSocket server backed by Redis. Manages connections, rooms, presence,
 * pub/sub channels, versioned records, collections, and structured commands across any
 * number of server instances sharing one Redis instance.
 */
export class RealtimeServer {
  /**
   * @param {RealtimeServerOptions} opts - Server configuration. `redis` is required.
   */
  constructor(opts = {}) {
    this.instanceId = randomUUID()
    this.status = Status.OFFLINE
    this._listening = false
    this._wss = null
    this._httpServer = null
    this._authenticateConnection = opts.authenticateConnection
    this._tracer = opts.tracer ?? null

    this.serverOptions = {
      ...opts,
      pingInterval: opts.pingInterval ?? 30_000,
      latencyInterval: opts.latencyInterval ?? 5_000,
      maxMissedPongs: opts.maxMissedPongs ?? 1,
      logLevel: opts.logLevel ?? LogLevel.ERROR,
      enablePresenceExpirationEvents: opts.enablePresenceExpirationEvents ?? true,
    }

    configureLogLevel(this.serverOptions.logLevel)

    this.redisManager = new RedisManager()
    this.redisManager.initialize(opts.redis, (err) => this._emitError(err))

    this.instanceManager = new InstanceManager({
      redis: this.redisManager.redis,
      instanceId: this.instanceId,
      getRegistry: () => this._snapshotExposed(),
    })

    this.roomManager = new RoomManager({ redis: this.redisManager.redis })
    this.recordManager = new RecordManager({ redis: this.redisManager.redis, server: this })
    this.connectionManager = new ConnectionManager({ redis: this.redisManager.pubClient, instanceId: this.instanceId, roomManager: this.roomManager })
    this.presenceManager = new PresenceManager({
      redis: this.redisManager.redis,
      roomManager: this.roomManager,
      redisManager: this.redisManager,
      enableExpirationEvents: this.serverOptions.enablePresenceExpirationEvents,
    })

    if (this.serverOptions.enablePresenceExpirationEvents) {
      this.redisManager.enableKeyspaceNotifications().catch((err) => this._emitError(new Error(`Failed to enable keyspace notifications: ${err}`)))
    }

    this.commandManager = new CommandManager({ tracer: this._tracer })
    this.messageStream = new MessageStream()

    this.persistenceManager = opts.persistence
      ? new PersistenceManager({ adapter: opts.persistence })
      : null

    if (this.persistenceManager) {
      this.persistenceManager.setMessageStream(this.messageStream)
      this.persistenceManager.setRecordManager(this.recordManager)
    }

    this.channelManager = new ChannelManager({
      redis: this.redisManager.redis,
      pubClient: this.redisManager.pubClient,
      subClient: this.redisManager.subClient,
      messageStream: this.messageStream,
    })

    if (this.persistenceManager) {
      this.channelManager.setPersistenceManager(this.persistenceManager)
    }

    this.recordSubscriptionManager = new RecordSubscriptionManager({
      pubClient: this.redisManager.pubClient,
      redis: this.redisManager.redis,
      recordManager: this.recordManager,
      emitError: (err) => this._emitError(err),
      persistenceManager: this.persistenceManager,
    })

    this.collectionManager = new CollectionManager({ redis: this.redisManager.redis, emitError: (err) => this._emitError(err) })

    this.recordManager.onRecordUpdate(async ({ recordId }) => {
      try { await this.collectionManager.publishRecordChange(recordId) }
      catch (error) { this._emitError(new Error(`Failed to publish record update for collection check: ${error}`)) }
    })

    this.recordManager.onRecordRemoved(async ({ recordId }) => {
      try { await this.collectionManager.publishRecordChange(recordId) }
      catch (error) { this._emitError(new Error(`Failed to publish record removal for collection check: ${error}`)) }
    })

    this.pubSubManager = new PubSubManager({
      subClient: this.redisManager.subClient,
      pubClient: this.redisManager.pubClient,
      instanceId: this.instanceId,
      connectionManager: this.connectionManager,
      recordManager: this.recordManager,
      recordSubscriptions: this.recordSubscriptionManager.getRecordSubscriptions(),
      getChannelSubscriptions: this.channelManager.getSubscribers.bind(this.channelManager),
      emitError: (err) => this._emitError(err),
      collectionManager: this.collectionManager,
    })

    this.broadcastManager = new BroadcastManager({
      connectionManager: this.connectionManager,
      roomManager: this.roomManager,
      instanceId: this.instanceId,
      pubClient: this.redisManager.pubClient,
      getPubSubChannel: (instanceId) => `${PUB_SUB_CHANNEL_PREFIX}${instanceId}`,
      emitError: (err) => this._emitError(err),
    })

    this._errorHandlers = []
    this._connectedHandlers = []
    this._disconnectedHandlers = []

    this._registerBuiltinCommands()
    this._registerRecordCommands()
  }

  /**
   * Number of connections currently attached to this server instance.
   * @returns {number}
   */
  get connectionCount() {
    return this.connectionManager.getLocalConnections().length
  }

  /**
   * Total number of connections across every server instance sharing this Redis instance.
   * @returns {Promise<number>}
   */
  async totalConnectionCount() {
    const ids = await this.connectionManager.getAllConnectionIds()
    return ids.length
  }

  /**
   * Install SIGTERM and SIGINT handlers that call `close()` and then `process.exit(0)`.
   * Call once during startup for clean shutdown on container stop or Ctrl-C.
   * @returns {this}
   */
  enableGracefulShutdown() {
    const handler = () => {
      serverLogger.info("received shutdown signal, closing")
      this.close().then(() => process.exit(0))
    }
    process.on("SIGTERM", handler)
    process.on("SIGINT", handler)
    return this
  }

  /**
   * The port the underlying server is bound to, or `undefined` if not listening yet.
   * Useful when the server was started on port 0 to get an OS-assigned port.
   * @returns {number | undefined}
   */
  get port() {
    const address = this._wss?.address()
    return address?.port
  }

  /**
   * Whether the server has finished starting and is accepting connections.
   * @returns {boolean}
   */
  get listening() {
    return this._listening
  }

  _emitError(err) {
    serverLogger.error("error", { err })
    for (const handler of this._errorHandlers) handler(err)
  }

  /**
   * Register a handler fired when the Redis connection (re)connects. Only one handler is
   * retained; a later call replaces the previous one.
   * @param {() => void} handler - Called on each Redis connect.
   * @returns {this}
   */
  onRedisConnect(handler) { this.redisManager._onRedisConnect = handler; return this }
  /**
   * Register a handler fired when the Redis connection closes unexpectedly (not during a
   * deliberate shutdown). Only one handler is retained; a later call replaces it.
   * @param {() => void} handler - Called on unexpected Redis disconnect.
   * @returns {this}
   */
  onRedisDisconnect(handler) { this.redisManager._onRedisDisconnect = handler; return this }
  /**
   * Register a handler for server errors. Errors are also logged. Multiple handlers may be
   * registered and all are invoked for each error.
   * @param {(err: Error) => void} handler - Receives each error.
   * @returns {this}
   */
  onError(handler) { this._errorHandlers.push(handler); return this }
  /**
   * Register a handler fired after a new connection has been registered and assigned an id.
   * Multiple handlers may be registered. Returned promises are not awaited.
   * @param {(connection: Connection) => void | Promise<void>} handler - Receives the new connection.
   * @returns {this}
   */
  onConnection(handler) { this._connectedHandlers.push(handler); return this }
  /**
   * Register a handler fired after a connection has closed and been cleaned up. Multiple
   * handlers may be registered. Returned promises are not awaited.
   * @param {(connection: Connection) => void | Promise<void>} handler - Receives the closed connection.
   * @returns {this}
   */
  onDisconnection(handler) { this._disconnectedHandlers.push(handler); return this }
  /**
   * Register a handler fired whenever any record's value changes on this server.
   * @param {(data: {recordId: string, value: any}) => void | Promise<void>} callback - Receives the record id and its new value.
   * @returns {() => void} Unsubscribe function that removes the handler.
   */
  onRecordUpdate(callback) { return this.recordManager.onRecordUpdate(callback) }
  /**
   * Register a handler fired whenever any record is deleted on this server.
   * @param {(data: {recordId: string, value: any}) => void | Promise<void>} callback - Receives the record id and its last value.
   * @returns {() => void} Unsubscribe function that removes the handler.
   */
  onRecordRemoved(callback) { return this.recordManager.onRecordRemoved(callback) }

  /**
   * Create and start an internal HTTP server on the given port, then begin accepting
   * WebSocket connections. Resolves once the server is fully initialized and online. Use
   * `attach` instead to share an existing HTTP server (for example an Express app).
   * @param {number} port - Port to listen on. Pass 0 to let the OS assign one (read it back via `port`).
   * @returns {Promise<void>}
   */
  async listen(port) {
    const httpServer = createHttpServer()
    this._httpServer = httpServer
    this._ownsHttpServer = true
    await this._startWithServer(httpServer, port)
  }

  /**
   * Attach to an existing HTTP server (for example one wrapping an Express app) and begin
   * accepting WebSocket connections on it. If the server is not already listening and a
   * port is given, it will be started on that port. Resolves once fully initialized.
   * @param {import('node:http').Server} httpServer - The HTTP server to share. Ownership stays with the caller; `close()` will not close it.
   * @param {{port?: number}} [options] - Options.
   * @param {number} [options.port] - Port to start the HTTP server on if it is not already listening.
   * @returns {Promise<void>}
   */
  async attach(httpServer, { port } = {}) {
    this._httpServer = httpServer
    this._ownsHttpServer = false
    const isListening = httpServer.listening
    if (!isListening && port !== undefined) {
      await new Promise((resolve) => { httpServer.listen(port, resolve) })
    } else if (!isListening) {
      await new Promise((resolve) => { httpServer.listen(resolve) })
    }
    await this._startWithServer(httpServer)
  }

  async _startWithServer(httpServer, port) {
    const wsOpts = { server: httpServer }

    if (this._authenticateConnection) {
      wsOpts.verifyClient = (info, cb) => {
        Promise.resolve()
          .then(() => this._authenticateConnection(info.req))
          .then((authData) => {
            if (authData != null) {
              pendingAuthDataStore.set(info.req, authData)
              cb(true)
            } else {
              cb(false, 401, "Unauthorized")
            }
          })
          .catch((err) => {
            const code = err?.code ?? 401
            const message = err?.message ?? "Unauthorized"
            cb(false, code, message)
          })
      }
    }

    this._wss = new WebSocketServer(wsOpts)

    if (port !== undefined && !httpServer.listening) {
      await new Promise((resolve) => { httpServer.listen(port, resolve) })
    }

    this._applyListeners()

    this.pubSubManager.subscribeToInstanceChannel()

    const persistencePromise = this.persistenceManager
      ? this.persistenceManager.initialize().then(() => this.persistenceManager.restorePersistedRecords())
      : Promise.resolve()

    await Promise.all([
      this.pubSubManager.getSubscriptionPromise(),
      persistencePromise,
    ])

    await this.instanceManager.start()

    this._listening = true
    this.status = Status.ONLINE
  }

  _applyListeners() {
    this._wss.on("connection", async (socket, req) => {
      const connection = new Connection(socket, req, this.serverOptions, this)

      connection.on("message", (buffer) => {
        try {
          const data = buffer.toString()
          const command = parseCommand(data)
          if (command.id !== undefined && !["latency:response", "pong"].includes(command.command)) {
            this.commandManager.runCommand(command.id, command.command, command.payload, connection, this)
          }
        } catch (err) {
          this._emitError(err)
        }
      })

      try {
        await this.connectionManager.registerConnection(connection)
        const authData = pendingAuthDataStore.get(req)
        if (authData) {
          pendingAuthDataStore.delete(req)
          await this.connectionManager.setMetadata(connection, authData)
        }
        connection.send({ command: "rt/assign-id", payload: connection.id })
      } catch (error) {
        connection.close()
        return
      }

      for (const handler of this._connectedHandlers) handler(connection)

      connection.on("close", async () => {
        await this.cleanupConnection(connection)
        for (const handler of this._disconnectedHandlers) handler(connection)
      })

      connection.on("error", (err) => {
        this._emitError(err)
      })

      connection.on("pong", async (connectionId) => {
        try {
          const rooms = await this.roomManager.getRoomsForConnection(connectionId)
          for (const roomName of rooms) {
            if (await this.presenceManager.isRoomTracked(roomName)) {
              await this.presenceManager.refreshPresence(connectionId, roomName)
            }
          }
        } catch (err) {
          this._emitError(new Error(`Failed to refresh presence: ${err}`))
        }
      })
    })
  }

  /**
   * Register a named command that clients can invoke via `client.command(name, payload)`.
   * The handler's return value is sent back to the caller as the command result. Command
   * names beginning with "rt/" are reserved for built-in commands.
   * @param {string} command - Command name clients will call.
   * @param {(ctx: Context) => any | Promise<any>} callback - Handler receiving the command context; its return value becomes the result.
   * @param {Array<(ctx: Context) => any | Promise<any>>} [middlewares] - Optional middlewares run before the handler for this command only.
   * @returns {void}
   */
  exposeCommand(command, callback, middlewares = []) {
    this.commandManager.exposeCommand(command, callback, middlewares)
  }

  /**
   * Register global middleware run before every command handler. A middleware that throws
   * aborts the command. Call multiple times to add more; they run in registration order.
   * @param {...(ctx: Context) => any | Promise<any>} middlewares - One or more middleware functions.
   * @returns {void}
   */
  useMiddleware(...middlewares) {
    this.commandManager.useMiddleware(...middlewares)
  }


  /**
   * Allow clients to subscribe to channels matching the pattern. Without an exposed
   * pattern, channel subscriptions are rejected. An optional guard authorizes each
   * subscription per connection.
   * @param {ChannelPattern} channel - Exact channel name or a RegExp matched against channel names.
   * @param {(connection: Connection, channel: string) => boolean | Promise<boolean>} [guard] - Return true to allow the subscription. Omit to allow any matching channel.
   * @returns {void}
   */
  exposeChannel(channel, guard) {
    this.channelManager.exposeChannel(channel, guard)
  }

  /**
   * Publish a message to a channel; all subscribed connections across every instance
   * receive it.
   * @param {string} channel - Channel name to publish to.
   * @param {any} message - Message payload; non-string values are JSON-stringified automatically.
   * @param {number} [history] - Number of recent messages to retain in Redis for late subscribers (default 0, no history).
   * @returns {Promise<void>}
   */
  async writeChannel(channel, message, history = 0) {
    if (!this._tracer) return this.channelManager.writeChannel(channel, message, history, this.instanceId)
    return this._tracer.span('realtime.writeChannel', { 'realtime.channel': channel }, () =>
      this.channelManager.writeChannel(channel, message, history, this.instanceId))
  }

  /**
   * Persist messages published to channels matching the pattern, so they survive restarts
   * and can be replayed to late subscribers. Requires a persistence adapter in the server
   * options.
   * @param {ChannelPattern} pattern - Exact channel name or RegExp matched against channel names.
   * @param {Object} [options] - Persistence options.
   * @param {number} [options.historyLimit] - Maximum number of messages to retain per channel.
   * @param {(message: string, channel: string) => boolean} [options.filter] - Return true to persist a message; return false to skip it.
   * @param {number} [options.flushInterval] - Interval in milliseconds between flushes of buffered messages to the adapter.
   * @param {number} [options.maxBufferSize] - Maximum buffered messages before an immediate flush is forced.
   * @returns {void}
   */
  enableChannelPersistence(pattern, options = {}) {
    if (!this.persistenceManager) throw new Error("Persistence not enabled. Pass a persistence adapter in options.")
    this.persistenceManager.enableChannelPersistence(pattern, options)
  }

  /**
   * Persist records matching the pattern, so their latest value survives restarts and is
   * restored on startup. Requires a persistence adapter in the server options. Provide
   * either a per-pattern adapter override or custom persist/restore hooks.
   * @param {Object} config - Record persistence configuration.
   * @param {ChannelPattern} config.pattern - Exact record id or RegExp matched against record ids.
   * @param {{adapter?: any, restorePattern: string}} [config.adapter] - Optional adapter override and the pattern used to restore matching records on startup.
   * @param {{persist: (records: Array<{recordId: string, value: any, version: number}>) => Promise<void>, restore: () => Promise<Array<{recordId: string, value: any, version: number}>>}} [config.hooks] - Custom persist and restore hooks used instead of the adapter.
   * @param {number} [config.flushInterval] - Interval in milliseconds between flushes of buffered record writes.
   * @param {number} [config.maxBufferSize] - Maximum buffered records before an immediate flush is forced.
   * @returns {void}
   */
  enableRecordPersistence(config) {
    if (!this.persistenceManager) throw new Error("Persistence not enabled. Pass a persistence adapter in options.")
    this.persistenceManager.enableRecordPersistence(config)
  }

  /**
   * Allow clients to subscribe to (read) records matching the pattern. This grants read
   * access only; use `exposeWritableRecord` to also allow client writes. An optional guard
   * authorizes each subscription per connection.
   * @param {ChannelPattern} recordPattern - Exact record id or RegExp matched against record ids.
   * @param {(connection: Connection, recordId: string) => boolean | Promise<boolean>} [guard] - Return true to allow the subscription. Omit to allow any matching record.
   * @returns {void}
   */
  exposeRecord(recordPattern, guard) {
    this.recordSubscriptionManager.exposeRecord(recordPattern, guard)
  }

  /**
   * Allow clients to write records matching the pattern via the client API. This controls
   * write access only; expose the record with `exposeRecord` for clients to also read it.
   * An optional guard authorizes each write per connection.
   * @param {ChannelPattern} recordPattern - Exact record id or RegExp matched against record ids.
   * @param {(connection: Connection, recordId: string) => boolean | Promise<boolean>} [guard] - Return true to allow the write. Omit to allow any matching record.
   * @returns {void}
   */
  exposeWritableRecord(recordPattern, guard) {
    this.recordSubscriptionManager.exposeWritableRecord(recordPattern, guard)
  }

  /**
   * Write a record's value from the server, bumping its version and pushing the update to
   * all subscribers across every instance. This is the server-side write path and bypasses
   * the `exposeWritableRecord` guard, which only governs client writes.
   * @param {string} recordId - Record identifier.
   * @param {any} newValue - The new value, or a partial value when using a merge strategy.
   * @param {{strategy?: 'replace' | 'merge' | 'deepMerge'}} [options] - Write options.
   * @param {'replace' | 'merge' | 'deepMerge'} [options.strategy] - How to combine the new value with the existing one: replace it wholesale, shallow-merge, or recursively deep-merge (default "replace").
   * @returns {Promise<void>}
   */
  async writeRecord(recordId, newValue, options) {
    if (!this._tracer) return this.recordSubscriptionManager.writeRecord(recordId, newValue, options)
    return this._tracer.span('realtime.writeRecord', { 'realtime.recordId': recordId }, () =>
      this.recordSubscriptionManager.writeRecord(recordId, newValue, options))
  }

  /**
   * Read a record's current value.
   * @param {string} recordId - Record identifier.
   * @returns {Promise<any>} The current value, or `null` if the record does not exist.
   */
  async getRecord(recordId) {
    return this.recordManager.getRecord(recordId)
  }

  /**
   * Delete a record and notify all subscribers of its removal.
   * @param {string} recordId - Record identifier.
   * @returns {Promise<void>}
   */
  async deleteRecord(recordId) {
    const result = await this.recordManager.deleteRecord(recordId)
    if (result) await this.recordSubscriptionManager.publishRecordDeletion(recordId, result.version)
  }

  /**
   * List records whose ids match a Redis glob pattern, with optional mapping, sorting, and
   * slicing applied server-side. Useful for building the initial set behind a collection.
   * @param {string} pattern - Redis glob pattern, for example "user:*".
   * @param {Object} [options] - Listing options.
   * @param {(record: any) => any} [options.map] - Transform each record before returning.
   * @param {(a: any, b: any) => number} [options.sort] - Comparator used to order the results.
   * @param {{start: number, count: number}} [options.slice] - Return only `count` records starting at `start` (applied after sorting).
   * @returns {Promise<any[]>} The matching records.
   */
  async listRecordsMatching(pattern, options) {
    return this.collectionManager.listRecordsMatching(pattern, options)
  }

  /**
   * Expose a collection: a named, reactive list of record ids resolved per subscriber.
   * Clients subscribe by id and receive the resolved members plus live updates as matching
   * records change. The resolver runs per connection so it can scope results to the caller.
   * @param {ChannelPattern} pattern - Exact collection id or RegExp matched against collection ids.
   * @param {(connection: Connection, collectionId: string) => Promise<any[]> | any[]} resolver - Returns the collection's members (records or `{ id }` objects) for the given connection.
   * @returns {void}
   */
  exposeCollection(pattern, resolver) {
    this.collectionManager.exposeCollection(pattern, resolver)
  }

  /**
   * Check whether a connection is a member of a room.
   * @param {string} roomName - Room name.
   * @param {Connection | string} connection - A connection or its id.
   * @returns {Promise<boolean>}
   */
  async isInRoom(roomName, connection) {
    const connectionId = typeof connection === "string" ? connection : connection.id
    return this.roomManager.connectionIsInRoom(roomName, connectionId)
  }

  /**
   * Add a connection to a room. If presence is tracked for the room, the connection is
   * marked online there.
   * @param {string} roomName - Room name (created on first join).
   * @param {Connection | string} connection - A connection or its id.
   * @returns {Promise<void>}
   */
  async addToRoom(roomName, connection) {
    const connectionId = typeof connection === "string" ? connection : connection.id
    await this.roomManager.addToRoom(roomName, connection)
    if (await this.presenceManager.isRoomTracked(roomName)) {
      await this.presenceManager.markOnline(connectionId, roomName)
    }
  }

  /**
   * Remove a connection from a room. If presence is tracked for the room, the connection is
   * marked offline there.
   * @param {string} roomName - Room name.
   * @param {Connection | string} connection - A connection or its id.
   * @returns {Promise<void>}
   */
  async removeFromRoom(roomName, connection) {
    const connectionId = typeof connection === "string" ? connection : connection.id
    if (await this.presenceManager.isRoomTracked(roomName)) {
      await this.presenceManager.markOffline(connectionId, roomName)
    }
    return this.roomManager.removeFromRoom(roomName, connection)
  }

  /**
   * Remove a connection from every room it belongs to.
   * @param {Connection | string} connection - A connection or its id.
   * @returns {Promise<void>}
   */
  async removeFromAllRooms(connection) {
    return this.roomManager.removeFromAllRooms(connection)
  }

  /**
   * Remove all members from a room while keeping the room itself.
   * @param {string} roomName - Room name.
   * @returns {Promise<void>}
   */
  async clearRoom(roomName) { return this.roomManager.clearRoom(roomName) }
  /**
   * Delete a room entirely, removing all members and any room metadata.
   * @param {string} roomName - Room name.
   * @returns {Promise<void>}
   */
  async deleteRoom(roomName) { return this.roomManager.deleteRoom(roomName) }

  /**
   * Get the connection ids of every member of a room, across all instances.
   * @param {string} roomName - Room name.
   * @returns {Promise<string[]>}
   */
  async getRoomMembers(roomName) {
    return this.roomManager.getRoomConnectionIds(roomName)
  }

  /**
   * Get every member of a room along with its connection metadata.
   * @param {string} roomName - Room name.
   * @returns {Promise<Array<{id: string, metadata: any}>>} Members with their metadata (`metadata` is `null` when unavailable).
   */
  async getRoomMembersWithMetadata(roomName) {
    const connectionIds = await this.roomManager.getRoomConnectionIds(roomName)
    return Promise.all(
      connectionIds.map(async (connectionId) => {
        try {
          const connection = this.connectionManager.getLocalConnection(connectionId)
          let metadata
          if (connection) {
            metadata = await this.connectionManager.getMetadata(connection)
          } else {
            const metadataString = await this.redisManager.redis.hget("rt:connection-meta", connectionId)
            metadata = metadataString ? JSON.parse(metadataString) : null
          }
          return { id: connectionId, metadata }
        } catch {
          return { id: connectionId, metadata: null }
        }
      })
    )
  }

  /**
   * Get the names of all rooms that currently have members, across all instances.
   * @returns {Promise<string[]>}
   */
  async getAllRooms() { return this.roomManager.getAllRooms() }

  /**
   * Read a connection's metadata. Metadata is set initially by `authenticateConnection` and
   * can be updated by the server or the client.
   * @param {string} connectionId - Connection identifier.
   * @returns {Promise<any>} The metadata, or `null` if none is set.
   */
  async getConnectionMetadata(connectionId) {
    return this.connectionManager.getMetadata(connectionId)
  }

  /**
   * Set or update a connection's metadata, visible cluster-wide.
   * @param {string} connectionId - Connection identifier.
   * @param {any} metadata - The new metadata, or a partial value when using a merge strategy.
   * @param {{strategy?: 'replace' | 'merge' | 'deepMerge'}} [options] - Write options.
   * @param {'replace' | 'merge' | 'deepMerge'} [options.strategy] - How to combine with existing metadata: replace, shallow-merge, or recursively deep-merge (default "replace").
   * @returns {Promise<void>}
   */
  async setConnectionMetadata(connectionId, metadata, options) {
    return this.connectionManager.setMetadata(connectionId, metadata, options)
  }

  /**
   * Send a message to a single connection by id, regardless of which instance hosts it.
   * @param {string} connectionId - Target connection identifier.
   * @param {string} command - Command name the client receives.
   * @param {any} payload - Message payload.
   * @returns {Promise<void>}
   */
  async sendTo(connectionId, command, payload) {
    return this.broadcastManager.sendTo(connectionId, command, payload)
  }

  /**
   * Send a message to every connection whose metadata matches a predicate, across all
   * instances.
   * @param {(metadata: any) => boolean} predicate - Return true for connections that should receive the message.
   * @param {string} command - Command name the clients receive.
   * @param {any} payload - Message payload.
   * @returns {Promise<void>}
   */
  async sendToWhere(predicate, command, payload) {
    return this.broadcastManager.sendToWhere(predicate, command, payload)
  }

  /**
   * Find all connections whose metadata matches a predicate, across all instances.
   * @param {(metadata: any) => boolean} predicate - Return true to include a connection.
   * @returns {Promise<Array<{id: string, metadata: any}>>} Matching connections with their metadata.
   */
  async getConnectionsWhere(predicate) {
    return this.broadcastManager.getConnectionsWhere(predicate)
  }

  /**
   * Forcibly disconnect every connection whose metadata matches a predicate, across all
   * instances.
   * @param {(metadata: any) => boolean} predicate - Return true to disconnect a connection.
   * @returns {Promise<void>}
   */
  async disconnectWhere(predicate) {
    return this.broadcastManager.disconnectWhere(predicate)
  }

  /**
   * Send a message to every connection across all instances, or to a specific subset.
   * @param {string} command - Command name the clients receive.
   * @param {any} payload - Message payload.
   * @param {Connection[]} [connections] - Specific connections to target; broadcasts to everyone when omitted.
   * @returns {Promise<void>}
   */
  async broadcast(command, payload, connections) {
    return this.broadcastManager.broadcast(command, payload, connections)
  }

  /**
   * Send a message to every member of a room, across all instances.
   * @param {string} roomName - Room name.
   * @param {string} command - Command name the clients receive.
   * @param {any} payload - Message payload.
   * @returns {Promise<void>}
   */
  async broadcastRoom(roomName, command, payload) {
    return this.broadcastManager.broadcastRoom(roomName, command, payload)
  }

  /**
   * Broadcast to every connection except the excluded one(s). Useful for echoing an action
   * to everyone but its originator.
   * @param {string} command - Command name the clients receive.
   * @param {any} payload - Message payload.
   * @param {Connection | Connection[]} exclude - Connection or connections to skip.
   * @returns {Promise<void>}
   */
  async broadcastExclude(command, payload, exclude) {
    return this.broadcastManager.broadcastExclude(command, payload, exclude)
  }

  /**
   * Broadcast to every member of a room except the excluded one(s).
   * @param {string} roomName - Room name.
   * @param {string} command - Command name the clients receive.
   * @param {any} payload - Message payload.
   * @param {Connection | Connection[]} exclude - Connection or connections to skip.
   * @returns {Promise<void>}
   */
  async broadcastRoomExclude(roomName, command, payload, exclude) {
    return this.broadcastManager.broadcastRoomExclude(roomName, command, payload, exclude)
  }

  /**
   * Track presence for rooms matching the pattern, so clients can subscribe to online or
   * offline state and per-connection presence data. The second argument may be a guard
   * function or an options object carrying a guard and a TTL.
   * @param {ChannelPattern} roomPattern - Exact room name or RegExp matched against room names.
   * @param {((connection: Connection, roomName: string) => boolean | Promise<boolean>) | {ttl?: number, guard?: (connection: Connection, roomName: string) => boolean | Promise<boolean>}} [guardOrOptions] - A guard returning true to allow presence, or an options object. `ttl` is the presence expiry in seconds after which a connection is considered offline if it has not refreshed.
   * @returns {void}
   */
  trackPresence(roomPattern, guardOrOptions) {
    this.presenceManager.trackRoom(roomPattern, guardOrOptions)
  }

  _patternToString(p) {
    if (typeof p === "string") return p
    if (p instanceof RegExp) return p.toString()
    return String(p)
  }

  _snapshotExposed() {
    return {
      instanceId: this.instanceId,
      channels: this.channelManager.exposedChannels.map((p) => this._patternToString(p)),
      records: this.recordSubscriptionManager.exposedRecords.map((p) => this._patternToString(p)),
      writableRecords: this.recordSubscriptionManager.exposedWritableRecords.map((p) => this._patternToString(p)),
      collections: this.collectionManager.exposedCollections.map((e) => this._patternToString(e.pattern)),
      presence: this.presenceManager.trackedRooms.map((p) => this._patternToString(p)),
      commands: this.commandManager.commands
        ? Object.keys(this.commandManager.commands).filter((c) => !c.startsWith("rt/"))
        : [],
    }
  }

  /**
   * Get a snapshot of what every server instance has exposed (channels, records, writable
   * records, collections, presence rooms, and custom commands), keyed by instance id.
   * Useful for introspection and tooling.
   * @returns {Promise<Object<string, {instanceId: string, channels: string[], records: string[], writableRecords: string[], collections: string[], presence: string[], commands: string[]}>>}
   */
  async getExposedRegistryAcrossInstances() {
    const registries = await this.instanceManager.getAllRegistries()
    registries[this.instanceId] = this._snapshotExposed()
    return registries
  }

  _registerBuiltinCommands() {
    this.exposeCommand("rt/noop", async () => true)

    this.exposeCommand("rt/subscribe-channel", async (ctx) => {
      const { channel, historyLimit, since } = ctx.payload
      if (!(await this.channelManager.isChannelExposed(channel, ctx.connection))) {
        return { success: false, history: [] }
      }
      try {
        if (!this.channelManager.getSubscribers(channel)) {
          await this.channelManager.subscribeToRedisChannel(channel)
        }
        await this.channelManager.addSubscription(channel, ctx.connection)
        const history = historyLimit && historyLimit > 0 ? await this.channelManager.getChannelHistory(channel, historyLimit, since) : []
        return { success: true, history }
      } catch {
        return { success: false, history: [] }
      }
    })

    this.exposeCommand("rt/unsubscribe-channel", async (ctx) => {
      const { channel } = ctx.payload
      const wasSubscribed = await this.channelManager.removeSubscription(channel, ctx.connection)
      if (wasSubscribed && !this.channelManager.getSubscribers(channel)) {
        await this.channelManager.unsubscribeFromRedisChannel(channel)
      }
      return wasSubscribed
    })

    this.exposeCommand("rt/get-channel-history", async (ctx) => {
      const { channel, limit, since } = ctx.payload
      if (!(await this.channelManager.isChannelExposed(channel, ctx.connection))) {
        return { success: false, history: [] }
      }
      try {
        if (this.persistenceManager?.getChannelPersistenceOptions(channel)) {
          const messages = await this.persistenceManager.getMessages(
            channel, since, limit || this.persistenceManager.getChannelPersistenceOptions(channel)?.historyLimit
          )
          return { success: true, history: messages.map((msg) => msg.message) }
        } else {
          const history = await this.channelManager.getChannelHistory(channel, limit || 50, since)
          return { success: true, history }
        }
      } catch {
        return { success: false, history: [] }
      }
    })

    this.exposeCommand("rt/join-room", async (ctx) => {
      const { roomName } = ctx.payload
      await this.addToRoom(roomName, ctx.connection)
      const present = await this.getRoomMembersWithMetadata(roomName)
      return { success: true, present }
    })

    this.exposeCommand("rt/leave-room", async (ctx) => {
      const { roomName } = ctx.payload
      await this.removeFromRoom(roomName, ctx.connection)
      return { success: true }
    })

    this.exposeCommand("rt/get-connection-metadata", async (ctx) => {
      const { connectionId } = ctx.payload
      const connection = this.connectionManager.getLocalConnection(connectionId)
      if (connection) {
        const metadata = await this.connectionManager.getMetadata(connection)
        return { metadata }
      } else {
        const metadata = await this.redisManager.redis.hget("rt:connection-meta", connectionId)
        return { metadata: metadata ? JSON.parse(metadata) : null }
      }
    })

    this.exposeCommand("rt/get-my-connection-metadata", async (ctx) => {
      const connectionId = ctx.connection.id
      const connection = this.connectionManager.getLocalConnection(connectionId)
      if (connection) {
        const metadata = await this.connectionManager.getMetadata(connection)
        return { metadata }
      } else {
        const metadata = await this.redisManager.redis.hget("rt:connection-meta", connectionId)
        return { metadata: metadata ? JSON.parse(metadata) : null }
      }
    })

    this.exposeCommand("rt/set-my-connection-metadata", async (ctx) => {
      const { metadata, options } = ctx.payload
      const connectionId = ctx.connection.id
      const connection = this.connectionManager.getLocalConnection(connectionId)
      if (connection) {
        try {
          await this.connectionManager.setMetadata(connection, metadata, options)
          return { success: true }
        } catch {
          return { success: false }
        }
      } else {
        return { success: false }
      }
    })

    this.exposeCommand("rt/get-room-metadata", async (ctx) => {
      const { roomName } = ctx.payload
      const metadata = await this.roomManager.getMetadata(roomName)
      return { metadata }
    })
  }

  _registerRecordCommands() {
    this.exposeCommand("rt/subscribe-record", async (ctx) => {
      const { recordId, mode = "full" } = ctx.payload
      const connectionId = ctx.connection.id
      if (!(await this.recordSubscriptionManager.isRecordExposed(recordId, ctx.connection))) {
        return { success: false }
      }
      try {
        const { record, version } = await this.recordManager.getRecordAndVersion(recordId)
        await this.recordSubscriptionManager.addSubscription(recordId, connectionId, mode)
        return { success: true, record, version }
      } catch (e) {
        serverLogger.error("failed to subscribe to record", { recordId, err: e })
        return { success: false }
      }
    })

    this.exposeCommand("rt/unsubscribe-record", async (ctx) => {
      const { recordId } = ctx.payload
      return await this.recordSubscriptionManager.removeSubscription(recordId, ctx.connection.id)
    })

    this.exposeCommand("rt/publish-record-update", async (ctx) => {
      const { recordId, newValue, options } = ctx.payload
      if (!(await this.recordSubscriptionManager.isRecordWritable(recordId, ctx.connection))) {
        throw new Error(`Record "${recordId}" is not writable by this connection.`)
      }
      try {
        await this.writeRecord(recordId, newValue, options)
        return { success: true }
      } catch (e) {
        throw new Error(`Failed to publish update for record "${recordId}": ${e.message}`)
      }
    })

    this.exposeCommand("rt/subscribe-presence", async (ctx) => {
      const { roomName } = ctx.payload
      if (!(await this.presenceManager.isRoomTracked(roomName, ctx.connection))) {
        return { success: false, present: [] }
      }
      try {
        const presenceChannel = `rt:presence:updates:${roomName}`
        const wasEmpty = !this.channelManager.getSubscribers(presenceChannel)
        await this.channelManager.addSubscription(presenceChannel, ctx.connection)
        if (wasEmpty || this.channelManager.getSubscribers(presenceChannel)?.size === 1) {
          await this.channelManager.subscribeToRedisChannel(presenceChannel)
        }
        const present = await this.getRoomMembersWithMetadata(roomName)
        const statesMap = await this.presenceManager.getAllPresenceStates(roomName)
        const states = {}
        statesMap.forEach((state, connectionId) => { states[connectionId] = state })
        return { success: true, present, states }
      } catch (e) {
        serverLogger.error("failed to subscribe to presence for room", { roomName, err: e })
        return { success: false, present: [] }
      }
    })

    this.exposeCommand("rt/unsubscribe-presence", async (ctx) => {
      const { roomName } = ctx.payload
      const presenceChannel = `rt:presence:updates:${roomName}`
      return await this.channelManager.removeSubscription(presenceChannel, ctx.connection)
    })

    this.exposeCommand("rt/publish-presence-state", async (ctx) => {
      const { roomName, state, expireAfter, silent } = ctx.payload
      const connectionId = ctx.connection.id
      if (!state) return false
      if (!(await this.presenceManager.isRoomTracked(roomName, ctx.connection)) || !(await this.isInRoom(roomName, connectionId))) {
        return false
      }
      try {
        await this.presenceManager.publishPresenceState(connectionId, roomName, state, expireAfter, silent)
        return true
      } catch (e) {
        serverLogger.error("failed to publish presence state for room", { roomName, err: e })
        return false
      }
    })

    this.exposeCommand("rt/clear-presence-state", async (ctx) => {
      const { roomName } = ctx.payload
      const connectionId = ctx.connection.id
      if (!(await this.presenceManager.isRoomTracked(roomName, ctx.connection)) || !(await this.isInRoom(roomName, connectionId))) {
        return false
      }
      try {
        await this.presenceManager.clearPresenceState(connectionId, roomName)
        return true
      } catch (e) {
        serverLogger.error("failed to clear presence state for room", { roomName, err: e })
        return false
      }
    })

    this.exposeCommand("rt/get-presence-state", async (ctx) => {
      const { roomName } = ctx.payload
      if (!(await this.presenceManager.isRoomTracked(roomName, ctx.connection))) {
        return { success: false, present: [] }
      }
      try {
        const present = await this.presenceManager.getPresentConnections(roomName)
        const statesMap = await this.presenceManager.getAllPresenceStates(roomName)
        const states = {}
        statesMap.forEach((state, connectionId) => { states[connectionId] = state })
        return { success: true, present, states }
      } catch (e) {
        serverLogger.error("failed to get presence state for room", { roomName, err: e })
        return { success: false, present: [] }
      }
    })

    this.exposeCommand("rt/subscribe-collection", async (ctx) => {
      const { collectionId } = ctx.payload
      const connectionId = ctx.connection.id
      if (!(await this.collectionManager.isCollectionExposed(collectionId, ctx.connection))) {
        return { success: false, ids: [], records: [], version: 0 }
      }
      try {
        const { ids, records, version } = await this.collectionManager.addSubscription(collectionId, connectionId, ctx.connection)
        const recordsWithId = records.map((record) => ({ id: record.id, record }))
        return { success: true, ids, records: recordsWithId, version }
      } catch (e) {
        serverLogger.error("failed to subscribe to collection", { collectionId, err: e })
        return { success: false, ids: [], records: [], version: 0 }
      }
    })

    this.exposeCommand("rt/unsubscribe-collection", async (ctx) => {
      const { collectionId } = ctx.payload
      return this.collectionManager.removeSubscription(collectionId, ctx.connection.id)
    })
  }

  async cleanupConnection(connection) {
    serverLogger.info("cleaning up connection", { connectionId: connection.id })
    connection.stopIntervals()
    try {
      await this.presenceManager.cleanupConnection(connection)
      await this.connectionManager.cleanupConnection(connection)
      await this.roomManager.cleanupConnection(connection)
      await this.recordSubscriptionManager.cleanupConnection(connection)
      await this.channelManager.cleanupConnection(connection)
      await this.collectionManager.cleanupConnection(connection)
    } catch (err) {
      this._emitError(new Error(`Failed to clean up connection: ${err}`))
    }
  }

  /**
   * Gracefully shut down: close all connections, stop the WebSocket server, flush and shut
   * down persistence, release Redis clients, and stop the internal HTTP server if this
   * instance created it. An HTTP server passed to `attach` is left open for the caller to
   * close.
   * @returns {Promise<void>}
   */
  async close() {
    this.redisManager.isShuttingDown = true

    const connections = this.connectionManager.getLocalConnections()
    await Promise.all(
      connections.map(async (connection) => {
        if (!connection.isDead) await connection.close()
        await this.cleanupConnection(connection)
      })
    )

    if (this._wss) {
      await new Promise((resolve, reject) => {
        this._wss.close((err) => { if (err) reject(err); else resolve() })
      })
    }

    if (this.persistenceManager) {
      try { await this.persistenceManager.shutdown() }
      catch (err) { serverLogger.error("error shutting down persistence manager", { err }) }
    }

    await this.channelManager.cleanupAllSubscriptions()
    await this.instanceManager.stop()
    await this.pubSubManager.cleanup()
    await this.presenceManager.cleanup()

    this.redisManager.disconnect()

    if (this._httpServer && this._ownsHttpServer) {
      await new Promise((resolve) => { this._httpServer.close(resolve) })
    }

    this._listening = false
    this.status = Status.OFFLINE
  }
}
