import { serverLogger } from "../../shared/index.js"

export class PresenceManager {
  constructor({ redis, roomManager, redisManager, enableExpirationEvents = true }) {
    this.redis = redis
    this.roomManager = roomManager
    this.redisManager = redisManager
    this.presenceExpirationEventsEnabled = enableExpirationEvents

    this.PRESENCE_KEY_PATTERN = /^mesh:presence:room:(.+):conn:(.+)$/
    this.PRESENCE_STATE_KEY_PATTERN = /^mesh:presence:state:(.+):conn:(.+)$/
    this.trackedRooms = []
    this.roomGuards = new Map()
    this.roomTTLs = new Map()
    this.defaultTTL = 0

    if (this.presenceExpirationEventsEnabled) {
      this._subscribeToExpirationEvents()
    }
  }

  _getExpiredEventsPattern() {
    const dbIndex = this.redis.options?.db ?? 0
    return `__keyevent@${dbIndex}__:expired`
  }

  _subscribeToExpirationEvents() {
    const { subClient } = this.redisManager
    const pattern = this._getExpiredEventsPattern()
    subClient.psubscribe(pattern)
    subClient.on("pmessage", (_pattern, _channel, key) => {
      if (this.PRESENCE_KEY_PATTERN.test(key) || this.PRESENCE_STATE_KEY_PATTERN.test(key)) {
        this._handleExpiredKey(key)
      }
    })
  }

  async _handleExpiredKey(key) {
    try {
      let match = key.match(this.PRESENCE_KEY_PATTERN)
      if (match && match[1] && match[2]) {
        await this.markOffline(match[2], match[1])
        return
      }
      match = key.match(this.PRESENCE_STATE_KEY_PATTERN)
      if (match && match[1] && match[2]) {
        await this._publishPresenceStateUpdate(match[1], match[2], null)
      }
    } catch (err) {
      serverLogger.error("[PresenceManager] Failed to handle expired key:", err)
    }
  }

  trackRoom(roomPattern, guardOrOptions) {
    this.trackedRooms.push(roomPattern)
    if (typeof guardOrOptions === "function") {
      this.roomGuards.set(roomPattern, guardOrOptions)
    } else if (guardOrOptions && typeof guardOrOptions === "object") {
      if (guardOrOptions.guard) this.roomGuards.set(roomPattern, guardOrOptions.guard)
      if (guardOrOptions.ttl && typeof guardOrOptions.ttl === "number") {
        this.roomTTLs.set(roomPattern, guardOrOptions.ttl)
      }
    }
  }

  async isRoomTracked(roomName, connection) {
    const matchedPattern = this.trackedRooms.find((pattern) =>
      typeof pattern === "string" ? pattern === roomName : pattern.test(roomName)
    )
    if (!matchedPattern) return false
    if (connection) {
      const guard = this.roomGuards.get(matchedPattern)
      if (guard) {
        try { return await Promise.resolve(guard(connection, roomName)) }
        catch { return false }
      }
    }
    return true
  }

  getRoomTTL(roomName) {
    const matchedPattern = this.trackedRooms.find((pattern) =>
      typeof pattern === "string" ? pattern === roomName : pattern.test(roomName)
    )
    if (matchedPattern) {
      const ttl = this.roomTTLs.get(matchedPattern)
      if (ttl !== undefined) return ttl
    }
    return this.defaultTTL
  }

  presenceRoomKey(roomName) { return `mesh:presence:room:${roomName}` }
  presenceConnectionKey(roomName, connectionId) { return `mesh:presence:room:${roomName}:conn:${connectionId}` }
  presenceStateKey(roomName, connectionId) { return `mesh:presence:state:${roomName}:conn:${connectionId}` }

  async markOnline(connectionId, roomName) {
    const roomKey = this.presenceRoomKey(roomName)
    const connKey = this.presenceConnectionKey(roomName, connectionId)
    const ttl = this.getRoomTTL(roomName)
    const pipeline = this.redis.pipeline()
    pipeline.sadd(roomKey, connectionId)
    if (ttl > 0) {
      const ttlSeconds = Math.max(1, Math.floor(ttl / 1000))
      pipeline.set(connKey, "", "EX", ttlSeconds)
    } else {
      pipeline.set(connKey, "")
    }
    await pipeline.exec()
    await this._publishPresenceUpdate(roomName, connectionId, "join")
  }

  async markOffline(connectionId, roomName) {
    const roomKey = this.presenceRoomKey(roomName)
    const connKey = this.presenceConnectionKey(roomName, connectionId)
    const stateKey = this.presenceStateKey(roomName, connectionId)
    const pipeline = this.redis.pipeline()
    pipeline.srem(roomKey, connectionId)
    pipeline.del(connKey)
    pipeline.del(stateKey)
    await pipeline.exec()
    await this._publishPresenceUpdate(roomName, connectionId, "leave")
  }

  async refreshPresence(connectionId, roomName) {
    const connKey = this.presenceConnectionKey(roomName, connectionId)
    const ttl = this.getRoomTTL(roomName)
    if (ttl > 0) {
      const ttlSeconds = Math.max(1, Math.floor(ttl / 1000))
      await this.redis.set(connKey, "", "EX", ttlSeconds)
    } else {
      await this.redis.set(connKey, "")
    }
  }

  async getPresentConnections(roomName) {
    return this.redis.smembers(this.presenceRoomKey(roomName))
  }

  async _publishPresenceUpdate(roomName, connectionId, type) {
    const channel = `mesh:presence:updates:${roomName}`
    const message = JSON.stringify({ type, connectionId, roomName, timestamp: Date.now() })
    await this.redis.publish(channel, message)
  }

  async publishPresenceState(connectionId, roomName, state, expireAfter, silent) {
    const key = this.presenceStateKey(roomName, connectionId)
    const value = JSON.stringify(state)
    const pipeline = this.redis.pipeline()
    if (expireAfter && expireAfter > 0) {
      pipeline.set(key, value, "PX", expireAfter)
    } else {
      pipeline.set(key, value)
    }
    await pipeline.exec()
    if (silent) return
    await this._publishPresenceStateUpdate(roomName, connectionId, state)
  }

  async clearPresenceState(connectionId, roomName) {
    const key = this.presenceStateKey(roomName, connectionId)
    await this.redis.del(key)
    await this._publishPresenceStateUpdate(roomName, connectionId, null)
  }

  async getPresenceState(connectionId, roomName) {
    const key = this.presenceStateKey(roomName, connectionId)
    const value = await this.redis.get(key)
    if (!value) return null
    try { return JSON.parse(value) }
    catch (e) { serverLogger.error(`[PresenceManager] Failed to parse presence state: ${e}`); return null }
  }

  async getAllPresenceStates(roomName) {
    const result = new Map()
    const connections = await this.getPresentConnections(roomName)
    if (connections.length === 0) return result
    const pipeline = this.redis.pipeline()
    for (const connectionId of connections) {
      pipeline.get(this.presenceStateKey(roomName, connectionId))
    }
    const responses = await pipeline.exec()
    if (!responses) return result
    for (let i = 0; i < connections.length; i++) {
      const connectionId = connections[i]
      if (!connectionId) continue
      const [err, value] = responses[i] || []
      if (err || !value) continue
      try { result.set(connectionId, JSON.parse(value)) }
      catch (e) { serverLogger.error(`[PresenceManager] Failed to parse presence state: ${e}`) }
    }
    return result
  }

  async _publishPresenceStateUpdate(roomName, connectionId, state) {
    const channel = `mesh:presence:updates:${roomName}`
    const message = JSON.stringify({ type: "state", connectionId, roomName, state, timestamp: Date.now() })
    await this.redis.publish(channel, message)
  }

  async cleanupConnection(connection) {
    const connectionId = connection.id
    const rooms = await this.roomManager.getRoomsForConnection(connectionId)
    for (const roomName of rooms) {
      if (await this.isRoomTracked(roomName)) {
        await this.markOffline(connectionId, roomName)
      }
    }
  }

  async cleanup() {
    const { subClient } = this.redisManager
    if (subClient && subClient.status !== "end") {
      const pattern = this._getExpiredEventsPattern()
      await new Promise((resolve) => { subClient.punsubscribe(pattern, () => resolve()) })
    }
  }
}
