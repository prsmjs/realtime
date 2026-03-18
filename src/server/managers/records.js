import jsonpatch from "fast-json-patch"
import { deepMerge, isObject, serverLogger } from "../../shared/index.js"
import { RECORD_KEY_PREFIX, RECORD_VERSION_KEY_PREFIX } from "../utils/constants.js"

export class RecordManager {
  constructor({ redis, server }) {
    this.redis = redis
    this.server = server
    this.recordUpdateCallbacks = []
    this.recordRemovedCallbacks = []
  }

  getServer() { return this.server }
  getRedis() { return this.redis }

  recordKey(recordId) { return `${RECORD_KEY_PREFIX}${recordId}` }
  recordVersionKey(recordId) { return `${RECORD_VERSION_KEY_PREFIX}${recordId}` }

  async getRecord(recordId) {
    const data = await this.redis.get(this.recordKey(recordId))
    return data ? JSON.parse(data) : null
  }

  async getVersion(recordId) {
    const version = await this.redis.get(this.recordVersionKey(recordId))
    return version ? parseInt(version, 10) : 0
  }

  async getRecordAndVersion(recordId) {
    const pipeline = this.redis.pipeline()
    pipeline.get(this.recordKey(recordId))
    pipeline.get(this.recordVersionKey(recordId))
    const results = await pipeline.exec()
    const recordData = results?.[0]?.[1]
    const versionData = results?.[1]?.[1]
    const record = recordData ? JSON.parse(recordData) : null
    const version = versionData ? parseInt(versionData, 10) : 0
    return { record, version }
  }

  async publishUpdate(recordId, newValue, strategy = "replace") {
    const recordKey = this.recordKey(recordId)
    const versionKey = this.recordVersionKey(recordId)
    const { record: oldValue, version: oldVersion } = await this.getRecordAndVersion(recordId)

    let finalValue
    if (strategy === "merge") {
      finalValue = isObject(oldValue) && isObject(newValue) ? { ...oldValue, ...newValue } : newValue
    } else if (strategy === "deepMerge") {
      finalValue = isObject(oldValue) && isObject(newValue) ? deepMerge(oldValue, newValue) : newValue
    } else {
      finalValue = newValue
    }

    const patch = jsonpatch.compare(oldValue ?? {}, finalValue ?? {})
    if (patch.length === 0) return null

    const newVersion = oldVersion + 1
    const pipeline = this.redis.pipeline()
    pipeline.set(recordKey, JSON.stringify(finalValue))
    pipeline.set(versionKey, newVersion.toString())
    await pipeline.exec()

    if (this.recordUpdateCallbacks.length > 0) {
      Promise.all(
        this.recordUpdateCallbacks.map(async (callback) => {
          try { await callback({ recordId, value: finalValue }) }
          catch (error) { serverLogger.error(`Error in record update callback for ${recordId}:`, error) }
        })
      ).catch((error) => {
        serverLogger.error(`Error in record update callbacks for ${recordId}:`, error)
      })
    }

    return { patch, version: newVersion, finalValue }
  }

  async deleteRecord(recordId) {
    const { record, version } = await this.getRecordAndVersion(recordId)
    if (!record) return null

    const pipeline = this.redis.pipeline()
    pipeline.del(this.recordKey(recordId))
    pipeline.del(this.recordVersionKey(recordId))
    await pipeline.exec()

    if (this.recordRemovedCallbacks.length > 0) {
      Promise.all(
        this.recordRemovedCallbacks.map(async (callback) => {
          try { await callback({ recordId, value: record }) }
          catch (error) { serverLogger.error(`Error in record removed callback for ${recordId}:`, error) }
        })
      ).catch((error) => {
        serverLogger.error(`Error in record removed callbacks for ${recordId}:`, error)
      })
    }

    return { version }
  }

  onRecordUpdate(callback) {
    this.recordUpdateCallbacks.push(callback)
    return () => { this.recordUpdateCallbacks = this.recordUpdateCallbacks.filter((cb) => cb !== callback) }
  }

  onRecordRemoved(callback) {
    this.recordRemovedCallbacks.push(callback)
    return () => { this.recordRemovedCallbacks = this.recordRemovedCallbacks.filter((cb) => cb !== callback) }
  }
}
