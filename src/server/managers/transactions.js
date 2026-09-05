import { randomUUID } from "node:crypto"
import jsonpatch from "fast-json-patch"
import { CodeError, deepMerge, isObject, serverLogger } from "../../shared/index.js"

const TX_LOCK_KEY = "rt:tx:lock"
const TX_RECORD_LOCK_PREFIX = "rt:record-lock:"
const TX_LOCK_TTL_SECONDS = 10
const TX_LOCK_ACQUIRE_TIMEOUT_MS = 5000
const TX_LOCK_RETRY_MS = 25

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Staging surface handed to a transaction function. Writes and deletes are
 * staged here and applied atomically at commit time. Reads inside the
 * transaction see both the committed state and any staged changes
 * (read-your-writes). The transaction holds a pessimistic lock over its
 * records for the whole callback, so the callback runs exactly once.
 */
export class TransactionContext {
  constructor(manager) {
    this.manager = manager
    /** @type {Map<string, {recordId: string, mode: 'write'|'delete', value?: any, options?: Object}>} */
    this._staged = new Map()
  }

  /**
   * Read a record's current value inside the transaction. Sees staged
   * writes/deletes (read-your-writes). Because the transaction holds the
   * record locks, no other transaction can mutate the record concurrently,
   * so the value is live and stable for the duration of the callback.
   * @param {string} recordId
   * @returns {Promise<any>} The value, or `null` when the record does not exist.
   */
  async getRecord(recordId) {
    const staged = this._staged.get(recordId)
    if (staged?.mode === "delete") return null
    const value = await this.manager.recordManager.getRecord(recordId)
    if (staged?.mode === "write") return this._resolveValue(staged, { value })
    return value
  }

  /**
   * Stage a record write. Last staged op per record wins, mirroring the
   * persistence buffer semantics (a delete supersedes a write and vice versa).
   * @param {string} recordId
   * @param {any} value
   * @param {{strategy?: 'replace' | 'merge' | 'deepMerge'}} [options]
   * @returns {{op: 'write', recordId: string, success: true}}
   */
  writeRecord(recordId, value, options = {}) {
    this._staged.set(recordId, { recordId, mode: "write", value, options })
    return { op: "write", recordId, success: true }
  }

  /**
   * Stage a record delete.
   * @param {string} recordId
   * @returns {{op: 'delete', recordId: string, success: true}}
   */
  deleteRecord(recordId) {
    this._staged.set(recordId, { recordId, mode: "delete" })
    return { op: "delete", recordId, success: true }
  }

  /** @param {{mode: 'write'|'delete', value?: any, options?: Object}} staged @param {{value: any} | undefined} snap */
  _resolveValue(staged, snap) {
    const { value, options } = staged
    const oldValue = snap?.value
    const strategy = options?.strategy || "replace"
    if (strategy === "merge") return isObject(oldValue) && isObject(value) ? { ...oldValue, ...value } : value
    if (strategy === "deepMerge") return isObject(oldValue) && isObject(value) ? deepMerge(oldValue, value) : value
    return value
  }

  /**
   * Commit all staged operations atomically with a single Redis Lua script.
   * The script applies every op in one atomic server-side step (so the batch
   * lands all-or-nothing even against concurrent single-record writers that
   * do not take locks) and returns per-op outcomes (old value, new value,
   * version) used to build JSON Patches for subscribers.
   *
   * Serialization is guaranteed by the record locks held by the manager for
   * the duration of the callback, so no version oracle or conflict/retry loop
   * is needed here.
   *
   * @returns {Promise<{id: string, changes: any[]}>}
   */
  async _commit() {
    if (this._staged.size === 0) return { id: randomUUID(), changes: [] }
    const redis = this.manager.redis
    const recordManager = this.manager.recordManager

    const keys = []
    const args = []
    for (const [recordId, staged] of this._staged) {
      keys.push(recordManager.recordKey(recordId), recordManager.recordVersionKey(recordId))
      args.push(JSON.stringify(staged))
    }

    let reply
    try {
      reply = await redis.eval(TRANSACTION_SCRIPT, keys.length, ...keys, ...args)
    } catch (err) {
      serverLogger.error("transaction commit failed", { err })
      throw err
    }

    const parsed = typeof reply === "string" ? JSON.parse(reply) : reply
    const changes = []
    for (const outcome of parsed || []) {
      if (outcome.op === "delete") {
        changes.push({ recordId: outcome.recordId, deleted: true, version: outcome.version, value: outcome.old ?? null })
      } else {
        const patch = jsonpatch.compare(outcome.old ?? {}, outcome.new ?? {})
        if (patch.length === 0) continue
        changes.push({ recordId: outcome.recordId, patch, version: outcome.version, finalValue: outcome.new })
      }
    }
    return { id: randomUUID(), changes }
  }
}

/**
 * Lua script applying one atomic transaction commit. Holds no version oracle:
 * serialization is provided by the transaction record locks held by the
 * caller. Each op is applied in order; writes of an unchanged value and
 * deletes of missing records are no-ops, mirroring the single-record write
 * path. Returns per-op outcomes `{op, recordId, version, old, new}` so the
 * caller can build JSON Patches for subscribers.
 *
 * KEYS are, per touched record: [recordKey, versionKey] (2 keys per record).
 * ARGV is, per touched record: [JSON staged op].
 */
const TRANSACTION_SCRIPT = `
local results = {}
for i = 1, math.floor(#KEYS / 2) do
  local recordKey = KEYS[i * 2 - 1]
  local versionKey = KEYS[i * 2]
  local staged = cjson.decode(ARGV[i])
  local recordId = staged['recordId']
  local rawValue = redis.call('GET', recordKey)
  local oldValue = rawValue and cjson.decode(rawValue) or nil
  local rawVersion = redis.call('GET', versionKey)
  local oldVersion = rawVersion and tonumber(rawVersion) or 0
  local mode = staged['mode']

  if mode == 'delete' then
    if oldValue ~= nil then
      redis.call('DEL', recordKey)
      redis.call('DEL', versionKey)
      results[#results + 1] = { op = 'delete', recordId = recordId, version = oldVersion, old = oldValue }
    end
  else
    local strategy = 'replace'
    if staged['options'] and staged['options']['strategy'] then
      strategy = staged['options']['strategy']
    end
    local newValue = staged['value']
    local finalValue = newValue
    if strategy == 'merge' and oldValue ~= nil and type(oldValue) == 'table' and type(newValue) == 'table' then
      local merged = {}
      for k, v in pairs(oldValue) do merged[k] = v end
      for k, v in pairs(newValue) do merged[k] = v end
      finalValue = merged
    elseif strategy == 'deepMerge' and oldValue ~= nil and type(oldValue) == 'table' and type(newValue) == 'table' then
      local function deepcopy(o)
        if type(o) ~= 'table' then return o end
        local c = {}
        for k, v in pairs(o) do c[k] = deepcopy(v) end
        return c
      end
      local function mergeInto(base, overlay)
        for k, v in pairs(overlay) do
          if type(v) == 'table' and type(base[k]) == 'table' then
            mergeInto(base[k], v)
          else
            base[k] = deepcopy(v)
          end
        end
      end
      local merged = deepcopy(oldValue)
      mergeInto(merged, newValue)
      finalValue = merged
    end
    if cjson.encode(oldValue or cjson.null) ~= cjson.encode(finalValue or cjson.null) then
      local newVersion = oldVersion + 1
      redis.call('SET', recordKey, cjson.encode(finalValue))
      redis.call('SET', versionKey, newVersion)
      results[#results + 1] = { op = 'write', recordId = recordId, version = newVersion, old = oldValue, new = finalValue }
    end
  end
end
return cjson.encode(results)
`

/**
 * Serialized (pessimistic) multi-record transactions over records.
 *
 * Every transaction acquires a Redis lock before its callback runs and holds
 * it until the commit is applied, so concurrent transactions on the same
 * records queue instead of conflicting. The callback runs exactly once — no
 * re-execution or purity requirement. Lock acquisition and release follow the
 * pattern already used by `InstanceManager` (`SET ... NX EX` + Lua
 * compare-and-delete), which is correct across multiple server instances.
 *
 * Lock granularity:
 * - `commitBatch` and `transaction(fn, { records })` lock exactly the touched
 *   records, in sorted order, so transactions on disjoint records run
 *   concurrently without deadlock.
 * - `transaction(fn)` without a `records` list locks a single global
 *   transaction key (it cannot know which records the callback will touch up
 *   front), serializing all transactions on this namespace.
 *
 * Locks expire after 10s (crash-safe); acquisition waits up to 5s before
 * throwing `TransactionError`.
 */
export class TransactionManager {
  constructor({ redis, recordManager, recordSubscriptionManager, persistenceManager, emitError }) {
    this.redis = redis
    this.recordManager = recordManager
    this.recordSubscriptionManager = recordSubscriptionManager
    this.persistenceManager = persistenceManager || null
    this.emitError = emitError
  }

  /**
   * Run a transaction under a pessimistic lock. The callback receives a
   * `TransactionContext` to stage writes/deletes (and read live state); it
   * runs exactly once and may have side effects. On commit every staged
   * operation is applied atomically.
   *
   * If `options.records` is provided, only those records are locked (in
   * sorted order, deadlock-free); otherwise a single global transaction lock
   * is used. Use `records` when the callback's touched set is known up front
   * to allow concurrent transactions on disjoint records.
   *
   * @param {(tx: TransactionContext) => any | Promise<any>} fn
   * @param {{records?: string[]}} [options]
   * @returns {Promise<{id: string, result: any, changes: Array<{recordId: string, patch?: import('fast-json-patch').Operation[], version: number, finalValue?: any, deleted?: boolean, value?: any}>}>}
   */
  async transaction(fn, options = {}) {
    const records = Array.isArray(options.records) ? options.records : []
    const lockKeys = records.length
      ? [...new Set(records.map((recordId) => `${TX_RECORD_LOCK_PREFIX}${recordId}`))].sort()
      : [TX_LOCK_KEY]
    const token = randomUUID()

    const acquired = await this._acquireLocks(lockKeys, token)
    try {
      const tx = new TransactionContext(this)
      const result = await fn(tx)
      const { id, changes } = await tx._commit()
      await this._applyChanges(changes)
      return { id, result, changes }
    } finally {
      await this._releaseLocks(lockKeys, token)
    }
  }

  /**
   * Commit a fixed batch of operations (write/delete) atomically. The record
   * set is known from the operations, so exactly those records are locked in
   * sorted order (disjoint batches run concurrently). Used by the
   * `rt/transaction` client command; validation (writability) happens in the
   * caller before the batch is staged.
   * @param {Array<{op: 'write'|'delete', recordId: string, value?: any, options?: Object}>} operations
   * @returns {Promise<{id: string, results: Array<{op: string, recordId: string, success: boolean, version: number}>}>}
   */
  async commitBatch(operations) {
    const records = [...new Set(operations.map((op) => op.recordId))]
    const { id, result, changes } = await this.transaction(async (tx) => {
      const results = []
      for (const op of operations) {
        if (op.op === "write") {
          tx.writeRecord(op.recordId, op.value, op.options)
          results.push({ op: "write", recordId: op.recordId, success: true })
        } else if (op.op === "delete") {
          tx.deleteRecord(op.recordId)
          results.push({ op: "delete", recordId: op.recordId, success: true })
        }
      }
      return results
    }, { records })
    const versionByRecord = new Map()
    for (const change of changes) versionByRecord.set(change.recordId, change.version)
    return {
      id,
      results: result.map((entry) => ({ ...entry, version: versionByRecord.get(entry.recordId) ?? 0 })),
    }
  }

  /**
   * Acquire every lock in `lockKeys` (already sorted). If any cannot be
   * acquired, release the partial set and retry the whole set until the
   * acquire timeout elapses. Sorted acquisition order makes deadlock
   * impossible. Uses `SET key token NX EX ttl` like `InstanceManager`.
   * @param {string[]} lockKeys
   * @param {string} token
   * @returns {Promise<string[]>} The acquired lock keys.
   */
  async _acquireLocks(lockKeys, token) {
    const deadline = Date.now() + TX_LOCK_ACQUIRE_TIMEOUT_MS
    while (Date.now() < deadline) {
      const acquired = []
      let ok = true
      for (const key of lockKeys) {
        try {
          const result = await this.redis.set(key, token, "EX", TX_LOCK_TTL_SECONDS, "NX")
          if (result === "OK") {
            acquired.push(key)
          } else {
            ok = false
            break
          }
        } catch {
          ok = false
          break
        }
      }
      if (ok) return acquired
      await this._releaseLocks(acquired, token)
      await sleep(TX_LOCK_RETRY_MS)
    }
    throw new CodeError("Timed out acquiring transaction lock", "ETXN", "TransactionError")
  }

  /**
   * Release locks with the same Lua compare-and-delete idiom as
   * `InstanceManager._releaseCleanupLock`, so a lock is only released by its
   * owner token (stale TTL-expired locks are never clobbered).
   * @param {string[]} lockKeys
   * @param {string} token
   * @returns {Promise<void>}
   */
  async _releaseLocks(lockKeys, token) {
    const script =
      'if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) else return 0 end'
    for (const key of lockKeys) {
      try {
        await this.redis.eval(script, 1, key, token)
      } catch (err) {
        serverLogger.debug("failed to release transaction lock", { key, err })
        this.emitError(new Error(`Failed to release transaction lock "${key}": ${err}`))
      }
    }
  }

  async _applyChanges(changes) {
    for (const change of changes) {
      if (change.deleted) {
        // fires the server's onRecordRemoved wiring (collections + persistence)
        this.recordManager.notifyRecordRemoved(change.recordId, change.value)
        await this.recordSubscriptionManager.publishRecordDeletion(change.recordId, change.version)
      } else {
        this.recordManager.notifyRecordUpdated(change.recordId, change.finalValue)
        if (this.persistenceManager) {
          this.persistenceManager.handleRecordUpdate(change.recordId, change.finalValue, change.version)
        }
        await this.recordSubscriptionManager.publishRecordUpdate(change.recordId, change.finalValue, change.patch, change.version)
      }
    }
  }
}
