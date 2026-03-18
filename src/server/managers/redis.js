import { Redis } from "ioredis"

export class RedisManager {
  _redis = null
  _pubClient = null
  _subClient = null
  _isShuttingDown = false

  initialize(options, onError) {
    this._onRedisConnect = null
    this._onRedisDisconnect = null

    this._redis = new Redis({
      retryStrategy: (times) => {
        if (this._isShuttingDown) return null
        if (times > 10) return null
        return Math.min(1000 * Math.pow(2, times), 30000)
      },
      ...options,
    })
    this._redis.on("error", (err) => onError(new Error(`Redis error: ${err}`)))
    this._redis.on("connect", () => { if (this._onRedisConnect) this._onRedisConnect() })
    this._redis.on("close", () => { if (!this._isShuttingDown && this._onRedisDisconnect) this._onRedisDisconnect() })
    this._pubClient = this._redis.duplicate()
    this._subClient = this._redis.duplicate()
  }

  get redis() {
    if (!this._redis) throw new Error("Redis not initialized")
    return this._redis
  }

  get pubClient() {
    if (!this._pubClient) throw new Error("Redis pub client not initialized")
    return this._pubClient
  }

  get subClient() {
    if (!this._subClient) throw new Error("Redis sub client not initialized")
    return this._subClient
  }

  disconnect() {
    this._isShuttingDown = true
    if (this._pubClient) { this._pubClient.disconnect(); this._pubClient = null }
    if (this._subClient) { this._subClient.disconnect(); this._subClient = null }
    if (this._redis) { this._redis.disconnect(); this._redis = null }
  }

  get isShuttingDown() { return this._isShuttingDown }
  set isShuttingDown(value) { this._isShuttingDown = value }

  async enableKeyspaceNotifications() {
    const result = await this.redis.config("GET", "notify-keyspace-events")
    const currentConfig = Array.isArray(result) && result.length > 1 ? result[1] : ""
    let newConfig = currentConfig || ""
    if (!newConfig.includes("E")) newConfig += "E"
    if (!newConfig.includes("x")) newConfig += "x"
    await this.redis.config("SET", "notify-keyspace-events", newConfig)
  }
}
