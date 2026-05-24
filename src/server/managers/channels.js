export class ChannelManager {
  constructor({ redis, pubClient, subClient, messageStream }) {
    this.redis = redis
    this.pubClient = pubClient
    this.subClient = subClient
    this.messageStream = messageStream
    this.exposedChannels = []
    this.channelGuards = new Map()
    this.channelSubscriptions = {}
    this.persistenceManager = null
  }

  setPersistenceManager(manager) {
    this.persistenceManager = manager
  }

  exposeChannel(channel, guard) {
    this.exposedChannels.push(channel)
    if (guard) this.channelGuards.set(channel, guard)
  }

  async isChannelExposed(channel, connection) {
    const matchedPattern = this.exposedChannels.find((pattern) =>
      typeof pattern === "string" ? pattern === channel : pattern.test(channel)
    )
    if (!matchedPattern) return false
    const guard = this.channelGuards.get(matchedPattern)
    if (guard) {
      try { return await Promise.resolve(guard(connection, channel)) }
      catch { return false }
    }
    return true
  }

  async writeChannel(channel, message, history = 0, instanceId) {
    const serialized = typeof message === "string" ? message : JSON.stringify(message)
    const parsedHistory = parseInt(history, 10)
    if (!isNaN(parsedHistory) && parsedHistory > 0) {
      await this.pubClient.rpush(`rt:history:${channel}`, serialized)
      await this.pubClient.ltrim(`rt:history:${channel}`, -parsedHistory, -1)
    }
    this.messageStream.publishMessage(channel, serialized, instanceId)
    await this.pubClient.publish(channel, serialized)
  }

  async addSubscription(channel, connection) {
    if (!this.channelSubscriptions[channel]) {
      this.channelSubscriptions[channel] = new Set()
    }
    this.channelSubscriptions[channel].add(connection)
    try {
      const pipeline = this.redis.pipeline()
      pipeline.sadd(`rt:ch:subs:${channel}`, connection.id)
      pipeline.sadd(`rt:conn:subs:channels:${connection.id}`, channel)
      await pipeline.exec()
    } catch {}
  }

  async removeSubscription(channel, connection) {
    let removed = false
    if (this.channelSubscriptions[channel]) {
      this.channelSubscriptions[channel].delete(connection)
      if (this.channelSubscriptions[channel].size === 0) {
        delete this.channelSubscriptions[channel]
      }
      removed = true
    }
    try {
      const pipeline = this.redis.pipeline()
      pipeline.srem(`rt:ch:subs:${channel}`, connection.id)
      pipeline.srem(`rt:conn:subs:channels:${connection.id}`, channel)
      await pipeline.exec()
    } catch {}
    return removed
  }

  getSubscribers(channel) {
    return this.channelSubscriptions[channel]
  }

  async getAllSubscriberIds(channel) {
    try { return await this.redis.smembers(`rt:ch:subs:${channel}`) }
    catch { return [] }
  }

  async getSubscribedChannelsForConnection(connectionId) {
    try { return await this.redis.smembers(`rt:conn:subs:channels:${connectionId}`) }
    catch { return [] }
  }

  async listAllChannels() {
    const channels = new Set()
    let cursor = "0"
    do {
      try {
        const [next, keys] = await this.redis.scan(cursor, "MATCH", "rt:ch:subs:*", "COUNT", 100)
        cursor = next
        for (const key of keys) channels.add(key.slice("rt:ch:subs:".length))
      } catch { break }
    } while (cursor !== "0")
    return [...channels]
  }

  async subscribeToRedisChannel(channel) {
    return new Promise((resolve, reject) => {
      this.subClient.subscribe(channel, (err) => {
        if (err) reject(err)
        else resolve()
      })
    })
  }

  async unsubscribeFromRedisChannel(channel) {
    return new Promise((resolve, reject) => {
      this.subClient.unsubscribe(channel, (err) => {
        if (err) reject(err)
        else resolve()
      })
    })
  }

  async getChannelHistory(channel, limit, since) {
    if (this.persistenceManager && since !== undefined) {
      try {
        const messages = await this.persistenceManager.getMessages(channel, since, limit)
        return messages.map((msg) => msg.message)
      } catch {
        const historyKey = `rt:history:${channel}`
        return this.redis.lrange(historyKey, 0, limit - 1)
      }
    }
    const historyKey = `rt:history:${channel}`
    return this.redis.lrange(historyKey, 0, limit - 1)
  }

  async getPersistedMessages(channel, since, limit) {
    if (!this.persistenceManager) throw new Error("Persistence not enabled")
    return this.persistenceManager.getMessages(channel, since, limit)
  }

  async cleanupConnection(connection) {
    const seen = new Set()
    for (const channel in this.channelSubscriptions) {
      if (this.channelSubscriptions[channel].has(connection)) seen.add(channel)
    }
    try {
      const remote = await this.redis.smembers(`rt:conn:subs:channels:${connection.id}`)
      for (const c of remote) seen.add(c)
    } catch {}
    for (const channel of seen) {
      if (this.channelSubscriptions[channel]) {
        this.channelSubscriptions[channel].delete(connection)
        if (this.channelSubscriptions[channel].size === 0) {
          delete this.channelSubscriptions[channel]
        }
      }
    }
    if (seen.size === 0) return
    try {
      const pipeline = this.redis.pipeline()
      for (const channel of seen) pipeline.srem(`rt:ch:subs:${channel}`, connection.id)
      pipeline.del(`rt:conn:subs:channels:${connection.id}`)
      await pipeline.exec()
    } catch {}
  }

  async cleanupAllSubscriptions() {
    const channels = Object.keys(this.channelSubscriptions)
    for (const channel of channels) {
      try { await this.unsubscribeFromRedisChannel(channel) } catch {}
    }
    this.channelSubscriptions = {}
  }
}
