import { EventEmitter } from "node:events"
import { randomUUID } from "node:crypto"
import { serverLogger } from "../../shared/index.js"

export class PersistenceManager extends EventEmitter {
  constructor({ adapter }) {
    super()
    this.defaultAdapter = adapter
    this.channelPatterns = []
    this.recordPatterns = []
    this.messageBuffer = new Map()
    this.recordBuffer = new Map()
    this.flushTimers = new Map()
    this.recordFlushTimer = null
    this.isShuttingDown = false
    this.initialized = false
    this.recordManager = null
    this.pendingRecordUpdates = []
    this.messageStream = null
  }

  setMessageStream(messageStream) {
    this.messageStream = messageStream
  }

  setRecordManager(recordManager) {
    this.recordManager = recordManager
  }

  async ready() {
    if (this.initialized) return
    return new Promise((resolve) => { this.once("initialized", resolve) })
  }

  async _processPendingRecordUpdates() {
    if (this.pendingRecordUpdates.length === 0) return
    serverLogger.info(`Processing ${this.pendingRecordUpdates.length} pending record updates`)
    const updates = [...this.pendingRecordUpdates]
    this.pendingRecordUpdates = []
    for (const { recordId, value, version } of updates) {
      this.handleRecordUpdate(recordId, value, version)
    }
  }

  async initialize() {
    if (this.initialized) return
    try {
      if (this.defaultAdapter) await this.defaultAdapter.initialize()
      if (this.messageStream) {
        this._boundHandleStreamMessage = this._handleStreamMessage.bind(this)
        this.messageStream.subscribeToMessages(this._boundHandleStreamMessage)
      }
      this.initialized = true
      await this._processPendingRecordUpdates()
      this.emit("initialized")
    } catch (err) {
      serverLogger.error("Failed to initialize persistence manager:", err)
      throw err
    }
  }

  async restorePersistedRecords() {
    if (!this.recordManager) {
      serverLogger.warn("Cannot restore persisted records: record manager not available")
      return
    }
    const redis = this.recordManager.getRedis()
    if (!redis) {
      serverLogger.warn("Cannot restore records: Redis not available")
      return
    }
    try {
      serverLogger.info("Restoring persisted records...")
      if (this.recordPatterns.length === 0) {
        serverLogger.info("No record patterns to restore")
        return
      }
      for (const config of this.recordPatterns) {
        const { adapter, hooks } = config
        const patternLabel = hooks ? "(custom hooks)" : adapter?.restorePattern
        try {
          let records = []
          if (hooks) {
            records = await hooks.restore()
          } else if (adapter) {
            const adapterRecords = adapter.adapter.getRecords
              ? await adapter.adapter.getRecords(adapter.restorePattern)
              : []
            records = adapterRecords.map((r) => ({
              recordId: r.recordId,
              value: typeof r.value === "string" ? JSON.parse(r.value) : r.value,
              version: r.version,
            }))
          }
          if (records.length > 0) {
            serverLogger.info(`Restoring ${records.length} records for pattern ${patternLabel}`)
            for (const record of records) {
              try {
                const { recordId, value, version } = record
                const recordKey = this.recordManager.recordKey(recordId)
                const versionKey = this.recordManager.recordVersionKey(recordId)
                const pipeline = redis.pipeline()
                pipeline.set(recordKey, JSON.stringify(value))
                pipeline.set(versionKey, version.toString())
                await pipeline.exec()
              } catch (parseErr) {
                serverLogger.error(`Failed to restore record ${record.recordId}: ${parseErr}`)
              }
            }
          }
        } catch (patternErr) {
          serverLogger.error(`Error restoring records for pattern ${patternLabel}: ${patternErr}`)
        }
      }
      serverLogger.info("Finished restoring persisted records")
    } catch (err) {
      serverLogger.error("Failed to restore persisted records:", err)
    }
  }

  _handleStreamMessage(message) {
    const { channel, message: messageContent, instanceId, timestamp } = message
    this._handleChannelMessage(channel, messageContent, instanceId, timestamp)
  }

  enableChannelPersistence(pattern, options = {}) {
    const fullOptions = {
      historyLimit: options.historyLimit ?? 50,
      filter: options.filter ?? (() => true),
      adapter: options.adapter ?? this.defaultAdapter,
      flushInterval: options.flushInterval ?? 500,
      maxBufferSize: options.maxBufferSize ?? 100,
    }
    if (fullOptions.adapter !== this.defaultAdapter && !this.isShuttingDown) {
      fullOptions.adapter.initialize().catch((err) => {
        serverLogger.error(`Failed to initialize adapter for pattern ${pattern}:`, err)
      })
    }
    this.channelPatterns.push({ pattern, options: fullOptions })
  }

  enableRecordPersistence(config) {
    const { pattern, adapter, hooks, flushInterval, maxBufferSize } = config
    if (adapter && hooks) throw new Error("Cannot use both adapter and hooks. Choose one.")
    let resolvedAdapter
    if (adapter) {
      const adapterInstance = adapter.adapter ?? this.defaultAdapter
      resolvedAdapter = { adapter: adapterInstance, restorePattern: adapter.restorePattern }
      if (adapterInstance !== this.defaultAdapter && !this.isShuttingDown) {
        adapterInstance.initialize().catch((err) => {
          serverLogger.error(`Failed to initialize adapter for record pattern ${pattern}:`, err)
        })
      }
    }
    this.recordPatterns.push({
      pattern,
      adapter: resolvedAdapter,
      hooks,
      flushInterval: flushInterval ?? 500,
      maxBufferSize: maxBufferSize ?? 100,
    })
  }

  getChannelPersistenceOptions(channel) {
    for (const { pattern, options } of this.channelPatterns) {
      if ((typeof pattern === "string" && pattern === channel) || (pattern instanceof RegExp && pattern.test(channel))) {
        return options
      }
    }
    return undefined
  }

  getRecordPersistenceConfig(recordId) {
    for (const config of this.recordPatterns) {
      const { pattern } = config
      if ((typeof pattern === "string" && pattern === recordId) || (pattern instanceof RegExp && pattern.test(recordId))) {
        return config
      }
    }
    return undefined
  }

  _handleChannelMessage(channel, message, instanceId, timestamp) {
    if (!this.initialized || this.isShuttingDown) return
    const options = this.getChannelPersistenceOptions(channel)
    if (!options) return
    if (!options.filter(message, channel)) return
    const persistedMessage = {
      id: randomUUID(),
      channel,
      message,
      instanceId,
      timestamp: timestamp || Date.now(),
    }
    if (!this.messageBuffer.has(channel)) this.messageBuffer.set(channel, [])
    this.messageBuffer.get(channel).push(persistedMessage)
    if (this.messageBuffer.get(channel).length >= options.maxBufferSize) {
      this._flushChannel(channel)
      return
    }
    if (!this.flushTimers.has(channel)) {
      const timer = setTimeout(() => { this._flushChannel(channel) }, options.flushInterval)
      if (timer.unref) timer.unref()
      this.flushTimers.set(channel, timer)
    }
  }

  async _flushChannel(channel) {
    if (!this.messageBuffer.has(channel)) return
    if (this.flushTimers.has(channel)) {
      clearTimeout(this.flushTimers.get(channel))
      this.flushTimers.delete(channel)
    }
    const messages = this.messageBuffer.get(channel)
    if (messages.length === 0) return
    this.messageBuffer.set(channel, [])
    const options = this.getChannelPersistenceOptions(channel)
    if (!options) return
    try {
      await options.adapter.storeMessages(messages)
      this.emit("flushed", { channel, count: messages.length })
    } catch (err) {
      serverLogger.error(`Failed to flush messages for channel ${channel}:`, err)
      if (!this.isShuttingDown) {
        const currentMessages = this.messageBuffer.get(channel) || []
        this.messageBuffer.set(channel, [...messages, ...currentMessages])
        if (!this.flushTimers.has(channel)) {
          const timer = setTimeout(() => { this._flushChannel(channel) }, 1000)
          if (timer.unref) timer.unref()
          this.flushTimers.set(channel, timer)
        }
      }
    }
  }

  async flushAll() {
    const channels = Array.from(this.messageBuffer.keys())
    for (const channel of channels) {
      await this._flushChannel(channel)
    }
  }

  async getMessages(channel, since, limit) {
    if (!this.initialized) throw new Error("Persistence manager not initialized")
    const options = this.getChannelPersistenceOptions(channel)
    if (!options) throw new Error(`Channel ${channel} does not have persistence enabled`)
    await this._flushChannel(channel)
    return options.adapter.getMessages(channel, since, limit || options.historyLimit)
  }

  handleRecordUpdate(recordId, value, version) {
    if (this.isShuttingDown) return
    if (!this.initialized) {
      this.pendingRecordUpdates.push({ recordId, value, version })
      return
    }
    const config = this.getRecordPersistenceConfig(recordId)
    if (!config) return
    const persistedRecord = {
      recordId,
      value: JSON.stringify(value),
      version,
      timestamp: Date.now(),
    }
    this.recordBuffer.set(recordId, persistedRecord)
    if (this.recordBuffer.size >= config.maxBufferSize) {
      this.flushRecords()
      return
    }
    if (!this.recordFlushTimer) {
      this.recordFlushTimer = setTimeout(() => { this.flushRecords() }, config.flushInterval)
      if (this.recordFlushTimer.unref) this.recordFlushTimer.unref()
    }
  }

  async flushRecords() {
    if (this.recordBuffer.size === 0) return
    if (this.recordFlushTimer) {
      clearTimeout(this.recordFlushTimer)
      this.recordFlushTimer = null
    }
    const records = Array.from(this.recordBuffer.values())
    this.recordBuffer.clear()
    const recordsByAdapter = new Map()
    const recordsByPersistFn = new Map()
    for (const record of records) {
      const config = this.getRecordPersistenceConfig(record.recordId)
      if (!config) continue
      if (config.hooks) {
        if (!recordsByPersistFn.has(config.hooks.persist)) recordsByPersistFn.set(config.hooks.persist, [])
        recordsByPersistFn.get(config.hooks.persist).push(record)
      } else if (config.adapter) {
        if (!recordsByAdapter.has(config.adapter.adapter)) recordsByAdapter.set(config.adapter.adapter, [])
        recordsByAdapter.get(config.adapter.adapter).push(record)
      }
    }
    const handleFlushError = (failedRecords, err) => {
      serverLogger.error("Failed to flush records:", err)
      if (!this.isShuttingDown) {
        for (const record of failedRecords) this.recordBuffer.set(record.recordId, record)
        if (!this.recordFlushTimer) {
          this.recordFlushTimer = setTimeout(() => { this.flushRecords() }, 1000)
          if (this.recordFlushTimer.unref) this.recordFlushTimer.unref()
        }
      }
    }
    for (const [persistFn, persistRecords] of recordsByPersistFn.entries()) {
      try {
        const customRecords = persistRecords.map((r) => ({
          recordId: r.recordId,
          value: JSON.parse(r.value),
          version: r.version,
        }))
        await persistFn(customRecords)
        this.emit("recordsFlushed", { count: persistRecords.length })
      } catch (err) {
        handleFlushError(persistRecords, err)
      }
    }
    for (const [adapter, adapterRecords] of recordsByAdapter.entries()) {
      try {
        if (adapter.storeRecords) {
          await adapter.storeRecords(adapterRecords)
          this.emit("recordsFlushed", { count: adapterRecords.length })
        }
      } catch (err) {
        handleFlushError(adapterRecords, err)
      }
    }
  }

  async getPersistedRecords(pattern) {
    if (!this.initialized) throw new Error("Persistence manager not initialized")
    await this.flushRecords()
    try {
      if (this.defaultAdapter?.getRecords) {
        return await this.defaultAdapter.getRecords(pattern)
      }
    } catch (err) {
      serverLogger.error(`Failed to get persisted records for pattern ${pattern}:`, err)
    }
    return []
  }

  async shutdown() {
    if (this.isShuttingDown) return
    this.isShuttingDown = true
    if (this._boundHandleStreamMessage && this.messageStream) {
      this.messageStream.unsubscribeFromMessages(this._boundHandleStreamMessage)
    }
    for (const timer of this.flushTimers.values()) clearTimeout(timer)
    this.flushTimers.clear()
    if (this.recordFlushTimer) {
      clearTimeout(this.recordFlushTimer)
      this.recordFlushTimer = null
    }
    await this.flushAll()
    await this.flushRecords()
    const adapters = new Set()
    if (this.defaultAdapter) adapters.add(this.defaultAdapter)
    for (const { options } of this.channelPatterns) adapters.add(options.adapter)
    for (const config of this.recordPatterns) {
      if (config.adapter) adapters.add(config.adapter.adapter)
    }
    for (const adapter of adapters) {
      try { await adapter.close() }
      catch (err) { serverLogger.error("Error closing persistence adapter:", err) }
    }
    this.initialized = false
  }
}
