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
      await this.pubClient.rpush(`mesh:history:${channel}`, serialized)
      await this.pubClient.ltrim(`mesh:history:${channel}`, -parsedHistory, -1)
    }
    this.messageStream.publishMessage(channel, serialized, instanceId)
    await this.pubClient.publish(channel, serialized)
  }

  addSubscription(channel, connection) {
    if (!this.channelSubscriptions[channel]) {
      this.channelSubscriptions[channel] = new Set()
    }
    this.channelSubscriptions[channel].add(connection)
  }

  removeSubscription(channel, connection) {
    if (this.channelSubscriptions[channel]) {
      this.channelSubscriptions[channel].delete(connection)
      if (this.channelSubscriptions[channel].size === 0) {
        delete this.channelSubscriptions[channel]
      }
      return true
    }
    return false
  }

  getSubscribers(channel) {
    return this.channelSubscriptions[channel]
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
        const historyKey = `mesh:history:${channel}`
        return this.redis.lrange(historyKey, 0, limit - 1)
      }
    }
    const historyKey = `mesh:history:${channel}`
    return this.redis.lrange(historyKey, 0, limit - 1)
  }

  async getPersistedMessages(channel, since, limit) {
    if (!this.persistenceManager) throw new Error("Persistence not enabled")
    return this.persistenceManager.getMessages(channel, since, limit)
  }

  cleanupConnection(connection) {
    for (const channel in this.channelSubscriptions) {
      this.removeSubscription(channel, connection)
    }
  }

  async cleanupAllSubscriptions() {
    const channels = Object.keys(this.channelSubscriptions)
    for (const channel of channels) {
      try { await this.unsubscribeFromRedisChannel(channel) } catch {}
    }
    this.channelSubscriptions = {}
  }
}
