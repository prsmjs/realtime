import { serverLogger } from "../../shared/index.js"
import { createRecordStore, normalizeWrite, validateRecordId } from "./record-store.js"
import { RECORD_KEY_PREFIX, RECORD_VERSION_KEY_PREFIX } from "../utils/constants.js"

export class RecordManager {
  constructor({ redis, server }) {
    this.redis = redis
    this.server = server
    this.store = createRecordStore(redis, id => this.recordKey(id), id => this.recordVersionKey(id))
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
    const snapshot = await this.store.read(recordId)
    return { record: snapshot.value, version: snapshot.version }
  }

  async publishUpdate(recordId, newValue, strategy = "replace") {
    validateRecordId(recordId)
    const staged = { mode: "write", ...normalizeWrite(newValue, { strategy }) }
    return this.store.withLock([recordId], async lease => {
      const snapshot = await this.store.read(recordId)
      const { entry, change } = this.store.prepare(snapshot, staged)
      await lease.commit([entry])
      if (!change) return null
      this.notifyRecordUpdated(recordId, change.finalValue)
      return { patch: change.patch, version: change.version, finalValue: change.finalValue }
    })
  }

  async deleteRecord(recordId) {
    validateRecordId(recordId)
    return this.store.withLock([recordId], async lease => {
      const snapshot = await this.store.read(recordId)
      const { entry, change } = this.store.prepare(snapshot, { mode: "delete" })
      await lease.commit([entry])
      if (!change) return null
      this.notifyRecordRemoved(recordId, change.value)
      return { version: change.version }
    })
  }

  /**
   * Fire registered update callbacks (notifications only; the caller is
   * responsible for persisting the new state). Used by the transaction path,
   * which writes to Redis directly via an atomic Lua script.
   * @param {string} recordId
   * @param {any} value
   * @returns {void}
   */
  notifyRecordUpdated(recordId, value) {
    if (this.recordUpdateCallbacks.length > 0) {
      Promise.all(
        this.recordUpdateCallbacks.map(async (callback) => {
          try { await callback({ recordId, value }) }
          catch (error) { serverLogger.error("error in record update callback", { recordId, err: error }) }
        })
      ).catch((error) => {
        serverLogger.error("error in record update callbacks", { recordId, err: error })
      })
    }
  }

  /**
   * Fire registered removal callbacks (notifications only). Used by the
   * transaction path, which deletes from Redis directly via an atomic Lua
   * script.
   * @param {string} recordId
   * @param {any} value
   * @returns {void}
   */
  notifyRecordRemoved(recordId, value) {
    if (this.recordRemovedCallbacks.length > 0) {
      Promise.all(
        this.recordRemovedCallbacks.map(async (callback) => {
          try { await callback({ recordId, value }) }
          catch (error) { serverLogger.error("error in record removed callback", { recordId, err: error }) }
        })
      ).catch((error) => {
        serverLogger.error("error in record removed callbacks", { recordId, err: error })
      })
    }
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
