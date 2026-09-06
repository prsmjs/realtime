import { randomUUID } from "node:crypto"
import { CodeError } from "../../shared/index.js"
import { normalizeWrite, resolveValue, validateRecordId } from "./record-store.js"

const contexts = new WeakMap()
const failure = (message) => new CodeError(message, "ETXN", "TransactionError")

function stateFor(tx, recordId) {
  const state = contexts.get(tx)
  if (!state?.active) throw failure("Transaction context is closed")
  state.lease.assert()
  validateRecordId(recordId)
  if (state.lease.allowed && !state.lease.allowed.has(recordId)) throw failure(`Record "${recordId}" is not declared in records`)
  return state
}

function snapshotFor(state, recordId) {
  if (!state.snapshots.has(recordId)) state.snapshots.set(recordId, state.store.read(recordId))
  return state.snapshots.get(recordId)
}

/** Record operations scoped to one transaction callback. */
export class TransactionContext {
  constructor(state) {
    contexts.set(this, state)
  }

  /**
   * Read committed state with staged changes applied. Returned values are detached copies.
   * @param {string} recordId
   * @returns {Promise<any>}
   */
  async getRecord(recordId) {
    const state = stateFor(this, recordId)
    const staged = state.staged.get(recordId)
    const snapshot = await snapshotFor(state, recordId)
    stateFor(this, recordId)
    const value = staged?.mode === "delete" ? null
      : staged?.mode === "write" ? resolveValue(snapshot.value, staged.value, staged.strategy)
      : snapshot.value
    return JSON.parse(JSON.stringify(value))
  }

  /**
   * Stage a write. The last operation for a record replaces earlier staged operations.
   * @param {string} recordId
   * @param {any} value
   * @param {{strategy?: 'replace' | 'merge' | 'deepMerge'}} [options]
   * @returns {{op: 'write', recordId: string, success: true}}
   */
  writeRecord(recordId, value, options = {}) {
    const state = stateFor(this, recordId)
    state.staged.set(recordId, { mode: "write", ...normalizeWrite(value, options) })
    return { op: "write", recordId, success: true }
  }

  /**
   * Stage a deletion.
   * @param {string} recordId
   * @returns {{op: 'delete', recordId: string, success: true}}
   */
  deleteRecord(recordId) {
    stateFor(this, recordId).staged.set(recordId, { mode: "delete" })
    return { op: "delete", recordId, success: true }
  }
}

/** Atomic record batches with renewable, ownership-checked locks. */
export class TransactionManager {
  constructor({ redis, recordManager, recordSubscriptionManager, persistenceManager, emitError }) {
    this.redis = redis
    this.recordManager = recordManager
    this.recordSubscriptionManager = recordSubscriptionManager
    this.persistenceManager = persistenceManager || null
    this.emitError = emitError
  }

  /**
   * Run the callback once and commit its staged changes together. Explicit records allow
   * disjoint transactions to run concurrently; omitting records excludes all record writers.
   * @param {(tx: TransactionContext) => any | Promise<any>} fn
   * @param {{records?: string[]}} [options]
   * @returns {Promise<{id: string, result: any, changes: Array<{recordId: string, patch?: import('fast-json-patch').Operation[], version: number, finalValue?: any, deleted?: boolean, value?: any}>}>}
   */
  async transaction(fn, options = {}) {
    if (typeof fn !== "function") throw failure("Transaction callback must be a function")
    if (!options || typeof options !== "object" || Array.isArray(options)) throw failure("Invalid transaction options")
    const store = this.recordManager.store
    return store.withLock(options.records, async lease => {
      const state = { active: true, store, lease, snapshots: new Map(), staged: new Map() }
      const tx = new TransactionContext(state)
      let result
      try { result = await fn(tx) }
      finally { state.active = false }
      const entries = []
      const changes = []
      for (const recordId of new Set([...state.snapshots.keys(), ...state.staged.keys()])) {
        const snapshot = await snapshotFor(state, recordId)
        const { entry, change } = store.prepare(snapshot, state.staged.get(recordId))
        entries.push(entry)
        if (change) changes.push(change)
      }
      await lease.commit(entries)
      await this._applyChanges(changes)
      return { id: randomUUID(), result, changes }
    })
  }

  /**
   * Commit a fixed batch. Each record may appear once; authorization belongs to the caller.
   * @param {Array<{op: 'write'|'delete', recordId: string, value?: any, options?: {strategy?: 'replace'|'merge'|'deepMerge'}}> } operations
   * @returns {Promise<{id: string, results: Array<{op: string, recordId: string, success: boolean, version: number}>}>}
   */
  async commitBatch(operations) {
    if (!Array.isArray(operations)) throw failure("Transaction operations must be an array")
    const records = new Set()
    const normalized = operations.map(op => {
      if (!op || (op.op !== "write" && op.op !== "delete")) throw failure("Invalid transaction operation")
      validateRecordId(op.recordId)
      if (records.has(op.recordId)) throw failure(`Duplicate transaction record "${op.recordId}"`)
      records.add(op.recordId)
      return op.op === "write"
        ? { op: op.op, recordId: op.recordId, ...normalizeWrite(op.value, op.options) }
        : { op: op.op, recordId: op.recordId }
    })
    const { id, result, changes } = await this.transaction(async tx => {
      const results = []
      for (const op of normalized) {
        const snapshot = await snapshotFor(contexts.get(tx), op.recordId)
        if (op.op === "write") tx.writeRecord(op.recordId, op.value, { strategy: op.strategy })
        else tx.deleteRecord(op.recordId)
        results.push({ op: op.op, recordId: op.recordId, success: true, version: snapshot.version })
      }
      return results
    }, { records: [...records] })
    const versions = new Map(changes.map(change => [change.recordId, change.version]))
    return { id, results: result.map(entry => ({ ...entry, version: versions.get(entry.recordId) ?? entry.version })) }
  }

  async _applyChanges(changes) {
    for (const change of changes) {
      // observer failures cannot turn an already committed transaction into a rejection
      try {
        if (change.deleted) this.recordManager.notifyRecordRemoved(change.recordId, change.value)
        else this.recordManager.notifyRecordUpdated(change.recordId, change.finalValue)
      } catch (error) { this._report(error) }
      try {
        if (change.deleted) {
          await this.recordSubscriptionManager.publishRecordDeletion(change.recordId, change.version)
        } else {
          this.persistenceManager?.handleRecordUpdate(change.recordId, change.finalValue, change.version)
          await this.recordSubscriptionManager.publishRecordUpdate(change.recordId, change.finalValue, change.patch, change.version)
        }
      } catch (error) { this._report(error) }
    }
  }

  _report(error) {
    try { this.emitError?.(error) }
    catch {}
  }
}
