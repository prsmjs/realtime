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
    await this.redis.sadd("rt:instances", this.instanceId)
  }

  async _deregisterInstance() {
    await this.redis.srem("rt:instances", this.instanceId)
    await this.redis.del(`rt:instance:${this.instanceId}:heartbeat`)
  }

  async _updateHeartbeat() {
    await this.redis.set(`rt:instance:${this.instanceId}:heartbeat`, Date.now().toString(), "EX", this.heartbeatTTL)
  }

  async _acquireCleanupLock() {
    const result = await this.redis.set("rt:cleanup:lock", this.instanceId, "EX", this.cleanupLockTTL, "NX")
    return result === "OK"
  }

  async _releaseCleanupLock() {
    const script = 'if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) else return 0 end'
    await this.redis.eval(script, 1, "rt:cleanup:lock", this.instanceId)
  }

  async _performCleanup() {
    try {
      const lockAcquired = await this._acquireCleanupLock()
      if (!lockAcquired) return
      const registeredInstances = await this.redis.smembers("rt:instances")
      const allConnections = await this.redis.hgetall("rt:connections")
      const instanceIds = new Set([...registeredInstances, ...Object.values(allConnections)])
      for (const instanceId of instanceIds) {
        if (instanceId === this.instanceId) continue
        const heartbeat = await this.redis.get(`rt:instance:${instanceId}:heartbeat`)
        if (!heartbeat) {
          serverLogger.info("found dead instance", { instanceId })
          await this._cleanupDeadInstance(instanceId)
        }
      }
    } catch (error) {
      serverLogger.error("error during cleanup", { err: error })
    } finally {
      await this._releaseCleanupLock()
    }
  }

  async _cleanupDeadInstance(instanceId) {
    try {
      const connectionsKey = `rt:connections:${instanceId}`
      const connections = await this.redis.smembers(connectionsKey)
      for (const connectionId of connections) {
        await this._cleanupConnection(connectionId)
      }
      const allConnections = await this.redis.hgetall("rt:connections")
      for (const [connectionId, connInstanceId] of Object.entries(allConnections)) {
        if (connInstanceId === instanceId) await this._cleanupConnection(connectionId)
      }
      await this.redis.srem("rt:instances", instanceId)
      await this.redis.del(connectionsKey)
      serverLogger.info("cleaned up dead instance", { instanceId })
    } catch (error) {
      serverLogger.error("error cleaning up instance", { instanceId, err: error })
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
      const roomsKey = `rt:connection:${connectionId}:rooms`
      const channelsKey = `rt:conn:subs:channels:${connectionId}`
      const recordsKey = `rt:conn:subs:records:${connectionId}`
      const collectionsKey = `rt:conn:subs:collections:${connectionId}`
      const [rooms, channels, records, collections] = await Promise.all([
        this.redis.smembers(roomsKey),
        this.redis.smembers(channelsKey),
        this.redis.smembers(recordsKey),
        this.redis.smembers(collectionsKey),
      ])
      const pipeline = this.redis.pipeline()
      for (const room of rooms) {
        pipeline.srem(`rt:room:${room}`, connectionId)
        pipeline.srem(`rt:presence:room:${room}`, connectionId)
        pipeline.del(`rt:presence:room:${room}:conn:${connectionId}`)
        pipeline.del(`rt:presence:state:${room}:conn:${connectionId}`)
      }
      for (const channel of channels) {
        pipeline.srem(`rt:ch:subs:${channel}`, connectionId)
      }
      for (const recordId of records) {
        pipeline.hdel(`rt:rec:subs:${recordId}`, connectionId)
      }
      for (const collectionId of collections) {
        pipeline.hdel(`rt:coll:subs:${collectionId}`, connectionId)
        pipeline.del(`rt:collection:${collectionId}:${connectionId}`)
      }
      pipeline.del(roomsKey, channelsKey, recordsKey, collectionsKey)
      pipeline.hdel("rt:connections", connectionId)
      pipeline.hdel("rt:connection-meta", connectionId)
      await this._deleteMatchingKeys(`rt:collection:*:${connectionId}`)
      await pipeline.exec()
      serverLogger.debug("cleaned up stale connection", { connectionId })
    } catch (error) {
      serverLogger.error("error cleaning up connection", { connectionId, err: error })
    }
  }
}
