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
 * @typedef {Object} RealtimeServerOptions
 * @property {{host?: string, port?: number, db?: number}} redis
 * @property {import('./managers/persistence.js').PersistenceAdapter} [persistence]
 * @property {(req: import('node:http').IncomingMessage) => Promise<any> | any} [authenticateConnection]
 * @property {number} [pingInterval]
 * @property {number} [latencyInterval]
 * @property {number} [maxMissedPongs]
 * @property {number} [logLevel]
 * @property {boolean} [enablePresenceExpirationEvents]
 */

/** @typedef {string | RegExp} ChannelPattern */

export class RealtimeServer {
  /** @param {RealtimeServerOptions} opts */
  constructor(opts = {}) {
    this.instanceId = randomUUID()
    this.status = Status.OFFLINE
    this._listening = false
    this._wss = null
    this._httpServer = null
    this._authenticateConnection = opts.authenticateConnection

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

    this.instanceManager = new InstanceManager({ redis: this.redisManager.redis, instanceId: this.instanceId })

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

    this.commandManager = new CommandManager()
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

  /** @returns {number} */
  get connectionCount() {
    return this.connectionManager.getLocalConnections().length
  }

  /** @returns {Promise<number>} */
  async totalConnectionCount() {
    const ids = await this.connectionManager.getAllConnectionIds()
    return ids.length
  }

  enableGracefulShutdown() {
    const handler = () => {
      serverLogger.info("received shutdown signal, closing")
      this.close().then(() => process.exit(0))
    }
    process.on("SIGTERM", handler)
    process.on("SIGINT", handler)
    return this
  }

  get port() {
    const address = this._wss?.address()
    return address?.port
  }

  get listening() {
    return this._listening
  }

  _emitError(err) {
    serverLogger.error("error", { err })
    for (const handler of this._errorHandlers) handler(err)
  }

  /** @param {() => void} handler @returns {this} */
  onRedisConnect(handler) { this.redisManager._onRedisConnect = handler; return this }
  /** @param {() => void} handler @returns {this} */
  onRedisDisconnect(handler) { this.redisManager._onRedisDisconnect = handler; return this }
  /** @param {(err: Error) => void} handler @returns {this} */
  onError(handler) { this._errorHandlers.push(handler); return this }
  /** @param {(connection: Connection) => void | Promise<void>} handler @returns {this} */
  onConnection(handler) { this._connectedHandlers.push(handler); return this }
  /** @param {(connection: Connection) => void | Promise<void>} handler @returns {this} */
  onDisconnection(handler) { this._disconnectedHandlers.push(handler); return this }
  /** @param {(data: {recordId: string, value: any}) => void | Promise<void>} callback @returns {() => void} */
  onRecordUpdate(callback) { return this.recordManager.onRecordUpdate(callback) }
  /** @param {(data: {recordId: string, value: any}) => void | Promise<void>} callback @returns {() => void} */
  onRecordRemoved(callback) { return this.recordManager.onRecordRemoved(callback) }

  /** @param {number} port @returns {Promise<void>} */
  async listen(port) {
    const httpServer = createHttpServer()
    this._httpServer = httpServer
    this._ownsHttpServer = true
    await this._startWithServer(httpServer, port)
  }

  /**
   * @param {import('node:http').Server} httpServer
   * @param {{port?: number}} [options]
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
   * @param {string} command
   * @param {(ctx: import('./context.js').Context) => any | Promise<any>} callback
   * @param {Array<(ctx: import('./context.js').Context) => any | Promise<any>>} [middlewares]
   */
  exposeCommand(command, callback, middlewares = []) {
    this.commandManager.exposeCommand(command, callback, middlewares)
  }

  /** @param {...(ctx: import('./context.js').Context) => any | Promise<any>} middlewares */
  useMiddleware(...middlewares) {
    this.commandManager.useMiddleware(...middlewares)
  }


  /**
   * @param {ChannelPattern} channel
   * @param {(connection: Connection, channel: string) => boolean | Promise<boolean>} [guard]
   */
  exposeChannel(channel, guard) {
    this.channelManager.exposeChannel(channel, guard)
  }

  /**
   * @param {string} channel
   * @param {any} message - auto-stringified if not a string
   * @param {number} [history] - number of messages to retain in redis history
   * @returns {Promise<void>}
   */
  async writeChannel(channel, message, history = 0) {
    return this.channelManager.writeChannel(channel, message, history, this.instanceId)
  }

  /**
   * @param {ChannelPattern} pattern
   * @param {{historyLimit?: number, filter?: (message: string, channel: string) => boolean, flushInterval?: number, maxBufferSize?: number}} [options]
   */
  enableChannelPersistence(pattern, options = {}) {
    if (!this.persistenceManager) throw new Error("Persistence not enabled. Pass a persistence adapter in options.")
    this.persistenceManager.enableChannelPersistence(pattern, options)
  }

  /**
   * @param {{pattern: ChannelPattern, adapter?: {adapter?: any, restorePattern: string}, hooks?: {persist: (records: Array<{recordId: string, value: any, version: number}>) => Promise<void>, restore: () => Promise<Array<{recordId: string, value: any, version: number}>>}, flushInterval?: number, maxBufferSize?: number}} config
   */
  enableRecordPersistence(config) {
    if (!this.persistenceManager) throw new Error("Persistence not enabled. Pass a persistence adapter in options.")
    this.persistenceManager.enableRecordPersistence(config)
  }

  /**
   * @param {ChannelPattern} recordPattern
   * @param {(connection: Connection, recordId: string) => boolean | Promise<boolean>} [guard]
   */
  exposeRecord(recordPattern, guard) {
    this.recordSubscriptionManager.exposeRecord(recordPattern, guard)
  }

  /**
   * @param {ChannelPattern} recordPattern
   * @param {(connection: Connection, recordId: string) => boolean | Promise<boolean>} [guard]
   */
  exposeWritableRecord(recordPattern, guard) {
    this.recordSubscriptionManager.exposeWritableRecord(recordPattern, guard)
  }

  /**
   * @param {string} recordId
   * @param {any} newValue
   * @param {{strategy?: 'replace' | 'merge' | 'deepMerge'}} [options]
   * @returns {Promise<void>}
   */
  async writeRecord(recordId, newValue, options) {
    return this.recordSubscriptionManager.writeRecord(recordId, newValue, options)
  }

  /** @param {string} recordId @returns {Promise<any>} */
  async getRecord(recordId) {
    return this.recordManager.getRecord(recordId)
  }

  /** @param {string} recordId @returns {Promise<void>} */
  async deleteRecord(recordId) {
    const result = await this.recordManager.deleteRecord(recordId)
    if (result) await this.recordSubscriptionManager.publishRecordDeletion(recordId, result.version)
  }

  /**
   * @param {string} pattern - redis glob pattern (e.g. "user:*")
   * @param {{map?: (record: any) => any, sort?: (a: any, b: any) => number, slice?: {start: number, count: number}}} [options]
   * @returns {Promise<any[]>}
   */
  async listRecordsMatching(pattern, options) {
    return this.collectionManager.listRecordsMatching(pattern, options)
  }

  /**
   * @param {ChannelPattern} pattern
   * @param {(connection: Connection, collectionId: string) => Promise<any[]> | any[]} resolver
   */
  exposeCollection(pattern, resolver) {
    this.collectionManager.exposeCollection(pattern, resolver)
  }

  /**
   * @param {string} roomName
   * @param {Connection | string} connection
   * @returns {Promise<boolean>}
   */
  async isInRoom(roomName, connection) {
    const connectionId = typeof connection === "string" ? connection : connection.id
    return this.roomManager.connectionIsInRoom(roomName, connectionId)
  }

  /**
   * @param {string} roomName
   * @param {Connection | string} connection
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
   * @param {string} roomName
   * @param {Connection | string} connection
   * @returns {Promise<void>}
   */
  async removeFromRoom(roomName, connection) {
    const connectionId = typeof connection === "string" ? connection : connection.id
    if (await this.presenceManager.isRoomTracked(roomName)) {
      await this.presenceManager.markOffline(connectionId, roomName)
    }
    return this.roomManager.removeFromRoom(roomName, connection)
  }

  /** @param {Connection | string} connection @returns {Promise<void>} */
  async removeFromAllRooms(connection) {
    return this.roomManager.removeFromAllRooms(connection)
  }

  /** @param {string} roomName @returns {Promise<void>} */
  async clearRoom(roomName) { return this.roomManager.clearRoom(roomName) }
  /** @param {string} roomName @returns {Promise<void>} */
  async deleteRoom(roomName) { return this.roomManager.deleteRoom(roomName) }

  /** @param {string} roomName @returns {Promise<string[]>} */
  async getRoomMembers(roomName) {
    return this.roomManager.getRoomConnectionIds(roomName)
  }

  /** @param {string} roomName @returns {Promise<Array<{id: string, metadata: any}>>} */
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

  /** @returns {Promise<string[]>} */
  async getAllRooms() { return this.roomManager.getAllRooms() }

  /**
   * @param {string} connectionId
   * @returns {Promise<any>}
   */
  async getConnectionMetadata(connectionId) {
    return this.connectionManager.getMetadata(connectionId)
  }

  /**
   * @param {string} connectionId
   * @param {any} metadata
   * @param {{strategy?: 'replace' | 'merge' | 'deepMerge'}} [options]
   * @returns {Promise<void>}
   */
  async setConnectionMetadata(connectionId, metadata, options) {
    return this.connectionManager.setMetadata(connectionId, metadata, options)
  }

  /**
   * @param {string} connectionId
   * @param {string} command
   * @param {any} payload
   * @returns {Promise<void>}
   */
  async sendTo(connectionId, command, payload) {
    return this.broadcastManager.sendTo(connectionId, command, payload)
  }

  /**
   * @param {(metadata: any) => boolean} predicate
   * @param {string} command
   * @param {any} payload
   * @returns {Promise<void>}
   */
  async sendToWhere(predicate, command, payload) {
    return this.broadcastManager.sendToWhere(predicate, command, payload)
  }

  /**
   * @param {string} command
   * @param {any} payload
   * @param {Connection[]} [connections] - specific connections to target, or all if omitted
   * @returns {Promise<void>}
   */
  async broadcast(command, payload, connections) {
    return this.broadcastManager.broadcast(command, payload, connections)
  }

  /**
   * @param {string} roomName
   * @param {string} command
   * @param {any} payload
   * @returns {Promise<void>}
   */
  async broadcastRoom(roomName, command, payload) {
    return this.broadcastManager.broadcastRoom(roomName, command, payload)
  }

  /**
   * @param {string} command
   * @param {any} payload
   * @param {Connection | Connection[]} exclude
   * @returns {Promise<void>}
   */
  async broadcastExclude(command, payload, exclude) {
    return this.broadcastManager.broadcastExclude(command, payload, exclude)
  }

  /**
   * @param {string} roomName
   * @param {string} command
   * @param {any} payload
   * @param {Connection | Connection[]} exclude
   * @returns {Promise<void>}
   */
  async broadcastRoomExclude(roomName, command, payload, exclude) {
    return this.broadcastManager.broadcastRoomExclude(roomName, command, payload, exclude)
  }

  /**
   * @param {ChannelPattern} roomPattern
   * @param {((connection: Connection, roomName: string) => boolean | Promise<boolean>) | {ttl?: number, guard?: (connection: Connection, roomName: string) => boolean | Promise<boolean>}} [guardOrOptions]
   */
  trackPresence(roomPattern, guardOrOptions) {
    this.presenceManager.trackRoom(roomPattern, guardOrOptions)
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
        this.channelManager.addSubscription(channel, ctx.connection)
        const history = historyLimit && historyLimit > 0 ? await this.channelManager.getChannelHistory(channel, historyLimit, since) : []
        return { success: true, history }
      } catch {
        return { success: false, history: [] }
      }
    })

    this.exposeCommand("rt/unsubscribe-channel", async (ctx) => {
      const { channel } = ctx.payload
      const wasSubscribed = this.channelManager.removeSubscription(channel, ctx.connection)
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
        this.recordSubscriptionManager.addSubscription(recordId, connectionId, mode)
        return { success: true, record, version }
      } catch (e) {
        serverLogger.error("failed to subscribe to record", { recordId, err: e })
        return { success: false }
      }
    })

    this.exposeCommand("rt/unsubscribe-record", async (ctx) => {
      const { recordId } = ctx.payload
      return this.recordSubscriptionManager.removeSubscription(recordId, ctx.connection.id)
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
        this.channelManager.addSubscription(presenceChannel, ctx.connection)
        if (!this.channelManager.getSubscribers(presenceChannel) || this.channelManager.getSubscribers(presenceChannel)?.size === 1) {
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
      return this.channelManager.removeSubscription(presenceChannel, ctx.connection)
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
      this.recordSubscriptionManager.cleanupConnection(connection)
      this.channelManager.cleanupConnection(connection)
      await this.collectionManager.cleanupConnection(connection)
    } catch (err) {
      this._emitError(new Error(`Failed to clean up connection: ${err}`))
    }
  }

  /** @returns {Promise<void>} */
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
