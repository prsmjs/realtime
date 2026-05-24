import { RECORD_PUB_SUB_CHANNEL } from "../utils/constants.js"

export class RecordSubscriptionManager {
  constructor({ pubClient, recordManager, emitError, persistenceManager, redis }) {
    this.pubClient = pubClient
    this.redis = redis ?? pubClient
    this.recordManager = recordManager
    this.persistenceManager = persistenceManager || null
    this.exposedRecords = []
    this.exposedWritableRecords = []
    this.recordGuards = new Map()
    this.writableRecordGuards = new Map()
    this.recordSubscriptions = new Map()
    this.emitError = emitError
  }

  setPersistenceManager(persistenceManager) {
    this.persistenceManager = persistenceManager
  }

  exposeRecord(recordPattern, guard) {
    this.exposedRecords.push(recordPattern)
    if (guard) this.recordGuards.set(recordPattern, guard)
  }

  exposeWritableRecord(recordPattern, guard) {
    this.exposedWritableRecords.push(recordPattern)
    if (guard) this.writableRecordGuards.set(recordPattern, guard)
  }

  async isRecordExposed(recordId, connection) {
    const readPattern = this.exposedRecords.find((pattern) =>
      typeof pattern === "string" ? pattern === recordId : pattern.test(recordId)
    )
    let canRead = false
    if (readPattern) {
      const guard = this.recordGuards.get(readPattern)
      if (guard) {
        try { canRead = await Promise.resolve(guard(connection, recordId)) }
        catch { canRead = false }
      } else {
        canRead = true
      }
    }
    if (canRead) return true
    const writePattern = this.exposedWritableRecords.find((pattern) =>
      typeof pattern === "string" ? pattern === recordId : pattern.test(recordId)
    )
    if (writePattern) return true
    return false
  }

  async isRecordWritable(recordId, connection) {
    const matchedPattern = this.exposedWritableRecords.find((pattern) =>
      typeof pattern === "string" ? pattern === recordId : pattern.test(recordId)
    )
    if (!matchedPattern) return false
    const guard = this.writableRecordGuards.get(matchedPattern)
    if (guard) {
      try { return await Promise.resolve(guard(connection, recordId)) }
      catch { return false }
    }
    return true
  }

  async addSubscription(recordId, connectionId, mode) {
    if (!this.recordSubscriptions.has(recordId)) {
      this.recordSubscriptions.set(recordId, new Map())
    }
    this.recordSubscriptions.get(recordId).set(connectionId, mode)
    try {
      const pipeline = this.redis.pipeline()
      pipeline.hset(`rt:rec:subs:${recordId}`, connectionId, mode)
      pipeline.sadd(`rt:conn:subs:records:${connectionId}`, recordId)
      await pipeline.exec()
    } catch {}
  }

  async removeSubscription(recordId, connectionId) {
    let removed = false
    const recordSubs = this.recordSubscriptions.get(recordId)
    if (recordSubs?.has(connectionId)) {
      recordSubs.delete(connectionId)
      if (recordSubs.size === 0) this.recordSubscriptions.delete(recordId)
      removed = true
    }
    try {
      const pipeline = this.redis.pipeline()
      pipeline.hdel(`rt:rec:subs:${recordId}`, connectionId)
      pipeline.srem(`rt:conn:subs:records:${connectionId}`, recordId)
      await pipeline.exec()
    } catch {}
    return removed
  }

  getSubscribers(recordId) {
    return this.recordSubscriptions.get(recordId)
  }

  async getAllSubscribers(recordId) {
    try { return await this.redis.hgetall(`rt:rec:subs:${recordId}`) }
    catch { return {} }
  }

  async getSubscribedRecordsForConnection(connectionId) {
    try {
      const recordIds = await this.redis.smembers(`rt:conn:subs:records:${connectionId}`)
      const out = {}
      for (const recordId of recordIds) {
        const mode = await this.redis.hget(`rt:rec:subs:${recordId}`, connectionId)
        if (mode !== null) out[recordId] = mode
      }
      return out
    } catch { return {} }
  }

  async listAllRecordIds() {
    const ids = new Set()
    let cursor = "0"
    do {
      try {
        const [next, keys] = await this.redis.scan(cursor, "MATCH", "rt:rec:subs:*", "COUNT", 100)
        cursor = next
        for (const key of keys) ids.add(key.slice("rt:rec:subs:".length))
      } catch { break }
    } while (cursor !== "0")
    return [...ids]
  }

  async writeRecord(recordId, newValue, options) {
    const updateResult = await this.recordManager.publishUpdate(recordId, newValue, options?.strategy || "replace")
    if (!updateResult) return
    const { patch, version, finalValue } = updateResult
    if (this.persistenceManager) {
      this.persistenceManager.handleRecordUpdate(recordId, finalValue, version)
    }
    const messagePayload = { recordId, newValue: finalValue, patch, version }
    try {
      await this.pubClient.publish(RECORD_PUB_SUB_CHANNEL, JSON.stringify(messagePayload))
    } catch (err) {
      this.emitError(new Error(`Failed to publish record update for "${recordId}": ${err}`))
    }
  }

  async cleanupConnection(connection) {
    const connectionId = connection.id
    const seen = new Set()
    this.recordSubscriptions.forEach((subscribers, recordId) => {
      if (subscribers.has(connectionId)) {
        seen.add(recordId)
        subscribers.delete(connectionId)
        if (subscribers.size === 0) this.recordSubscriptions.delete(recordId)
      }
    })
    try {
      const remote = await this.redis.smembers(`rt:conn:subs:records:${connectionId}`)
      for (const r of remote) seen.add(r)
    } catch {}
    if (seen.size === 0) return
    try {
      const pipeline = this.redis.pipeline()
      for (const recordId of seen) pipeline.hdel(`rt:rec:subs:${recordId}`, connectionId)
      pipeline.del(`rt:conn:subs:records:${connectionId}`)
      await pipeline.exec()
    } catch {}
  }

  async publishRecordDeletion(recordId, version) {
    const messagePayload = { recordId, deleted: true, version }
    try {
      await this.pubClient.publish(RECORD_PUB_SUB_CHANNEL, JSON.stringify(messagePayload))
    } catch (err) {
      this.emitError(new Error(`Failed to publish record deletion for "${recordId}": ${err}`))
    }
  }

  getRecordSubscriptions() {
    return this.recordSubscriptions
  }
}
