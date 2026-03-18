import { RECORD_PUB_SUB_CHANNEL } from "../utils/constants.js"

export class RecordSubscriptionManager {
  constructor({ pubClient, recordManager, emitError, persistenceManager }) {
    this.pubClient = pubClient
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

  addSubscription(recordId, connectionId, mode) {
    if (!this.recordSubscriptions.has(recordId)) {
      this.recordSubscriptions.set(recordId, new Map())
    }
    this.recordSubscriptions.get(recordId).set(connectionId, mode)
  }

  removeSubscription(recordId, connectionId) {
    const recordSubs = this.recordSubscriptions.get(recordId)
    if (recordSubs?.has(connectionId)) {
      recordSubs.delete(connectionId)
      if (recordSubs.size === 0) this.recordSubscriptions.delete(recordId)
      return true
    }
    return false
  }

  getSubscribers(recordId) {
    return this.recordSubscriptions.get(recordId)
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

  cleanupConnection(connection) {
    const connectionId = connection.id
    this.recordSubscriptions.forEach((subscribers, recordId) => {
      if (subscribers.has(connectionId)) {
        subscribers.delete(connectionId)
        if (subscribers.size === 0) this.recordSubscriptions.delete(recordId)
      }
    })
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
