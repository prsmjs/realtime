import { serverLogger } from "../../shared/index.js"

export class InstanceManager {
  constructor({ redis, instanceId }) {
    this.redis = redis
    this.instanceId = instanceId
    this.heartbeatInterval = null
    this.heartbeatTTL = 120
    this.heartbeatFrequency = 15000
    this.cleanupInterval = null
    this.cleanupFrequency = 60000
    this.cleanupLockTTL = 10
  }

  async start() {
    await this._registerInstance()
    await this._updateHeartbeat()
    this.heartbeatInterval = setInterval(() => this._updateHeartbeat(), this.heartbeatFrequency)
    this.heartbeatInterval.unref()
    this.cleanupInterval = setInterval(() => this._performCleanup(), this.cleanupFrequency)
    this.cleanupInterval.unref()
  }

  async stop() {
    if (this.heartbeatInterval) { clearInterval(this.heartbeatInterval); this.heartbeatInterval = null }
    if (this.cleanupInterval) { clearInterval(this.cleanupInterval); this.cleanupInterval = null }
    await this._deregisterInstance()
  }

  async _registerInstance() {
    await this.redis.sadd("mesh:instances", this.instanceId)
  }

  async _deregisterInstance() {
    await this.redis.srem("mesh:instances", this.instanceId)
    await this.redis.del(`mesh:instance:${this.instanceId}:heartbeat`)
  }

  async _updateHeartbeat() {
    await this.redis.set(`mesh:instance:${this.instanceId}:heartbeat`, Date.now().toString(), "EX", this.heartbeatTTL)
  }

  async _acquireCleanupLock() {
    const result = await this.redis.set("mesh:cleanup:lock", this.instanceId, "EX", this.cleanupLockTTL, "NX")
    return result === "OK"
  }

  async _releaseCleanupLock() {
    const script = 'if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) else return 0 end'
    await this.redis.eval(script, 1, "mesh:cleanup:lock", this.instanceId)
  }

  async _performCleanup() {
    try {
      const lockAcquired = await this._acquireCleanupLock()
      if (!lockAcquired) return
      const registeredInstances = await this.redis.smembers("mesh:instances")
      const allConnections = await this.redis.hgetall("mesh:connections")
      const instanceIds = new Set([...registeredInstances, ...Object.values(allConnections)])
      for (const instanceId of instanceIds) {
        if (instanceId === this.instanceId) continue
        const heartbeat = await this.redis.get(`mesh:instance:${instanceId}:heartbeat`)
        if (!heartbeat) {
          serverLogger.info(`Found dead instance: ${instanceId}`)
          await this._cleanupDeadInstance(instanceId)
        }
      }
    } catch (error) {
      serverLogger.error("Error during cleanup:", error)
    } finally {
      await this._releaseCleanupLock()
    }
  }

  async _cleanupDeadInstance(instanceId) {
    try {
      const connectionsKey = `mesh:connections:${instanceId}`
      const connections = await this.redis.smembers(connectionsKey)
      for (const connectionId of connections) {
        await this._cleanupConnection(connectionId)
      }
      const allConnections = await this.redis.hgetall("mesh:connections")
      for (const [connectionId, connInstanceId] of Object.entries(allConnections)) {
        if (connInstanceId === instanceId) await this._cleanupConnection(connectionId)
      }
      await this.redis.srem("mesh:instances", instanceId)
      await this.redis.del(connectionsKey)
      serverLogger.info(`Cleaned up dead instance: ${instanceId}`)
    } catch (error) {
      serverLogger.error(`Error cleaning up instance ${instanceId}:`, error)
    }
  }

  async _deleteMatchingKeys(pattern) {
    const stream = this.redis.scanStream({ match: pattern })
    const pipeline = this.redis.pipeline()
    stream.on("data", (keys) => { for (const key of keys) pipeline.del(key) })
    return new Promise((resolve, reject) => {
      stream.on("end", async () => { await pipeline.exec(); resolve() })
      stream.on("error", reject)
    })
  }

  async _cleanupConnection(connectionId) {
    try {
      const roomsKey = `mesh:connection:${connectionId}:rooms`
      const rooms = await this.redis.smembers(roomsKey)
      const pipeline = this.redis.pipeline()
      for (const room of rooms) {
        pipeline.srem(`mesh:room:${room}`, connectionId)
        pipeline.srem(`mesh:presence:room:${room}`, connectionId)
        pipeline.del(`mesh:presence:room:${room}:conn:${connectionId}`)
        pipeline.del(`mesh:presence:state:${room}:conn:${connectionId}`)
      }
      pipeline.del(roomsKey)
      pipeline.hdel("mesh:connections", connectionId)
      pipeline.hdel("mesh:connection-meta", connectionId)
      await this._deleteMatchingKeys(`mesh:collection:*:${connectionId}`)
      await pipeline.exec()
      serverLogger.debug(`Cleaned up stale connection: ${connectionId}`)
    } catch (error) {
      serverLogger.error(`Error cleaning up connection ${connectionId}:`, error)
    }
  }
}
