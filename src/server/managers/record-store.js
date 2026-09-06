import { AsyncLocalStorage } from "node:async_hooks"
import { randomUUID } from "node:crypto"
import { isDeepStrictEqual } from "node:util"
import jsonpatch from "fast-json-patch"
import { CodeError, deepMerge, isObject } from "../../shared/index.js"

const GLOBAL_LOCK = "rt:tx:lock"
const ACTIVE_LOCKS = "rt:tx:active"
const LOCK_PREFIX = "rt:record-lock:"
const LEASE_MS = 10_000
const ACQUIRE_TIMEOUT_MS = 5_000
const scope = new AsyncLocalStorage()
const failure = (message) => new CodeError(message, "ETXN", "TransactionError")

const ACQUIRE = `
local time = redis.call('TIME')
local now = time[1] * 1000 + math.floor(time[2] / 1000)
redis.call('ZREMRANGEBYSCORE', KEYS[2], '-inf', now)
if redis.call('EXISTS', KEYS[1]) ~= 0 then return 0 end
if ARGV[3] == 'global' then
  if redis.call('ZCARD', KEYS[2]) ~= 0 then return 0 end
  redis.call('SET', KEYS[1], ARGV[1], 'PX', ARGV[2])
else
  for i = 3, #KEYS do
    if redis.call('EXISTS', KEYS[i]) ~= 0 then return 0 end
  end
  for i = 3, #KEYS do redis.call('SET', KEYS[i], ARGV[1], 'PX', ARGV[2]) end
  redis.call('ZADD', KEYS[2], now + tonumber(ARGV[2]), ARGV[1])
  redis.call('PEXPIRE', KEYS[2], ARGV[2])
end
return 1
`

const CHECK_LEASE = `
local time = redis.call('TIME')
local now = time[1] * 1000 + math.floor(time[2] / 1000)
if ARGV[3] == 'global' then
  if redis.call('GET', KEYS[1]) ~= ARGV[1] then return redis.error_reply('Transaction lock lost') end
else
  local expiry = redis.call('ZSCORE', KEYS[2], ARGV[1])
  if not expiry or tonumber(expiry) <= now or redis.call('EXISTS', KEYS[1]) ~= 0 then
    return redis.error_reply('Transaction lock lost')
  end
  for i = 3, tonumber(ARGV[4]) do
    if redis.call('GET', KEYS[i]) ~= ARGV[1] then return redis.error_reply('Transaction lock lost') end
  end
end
`

const RENEW = CHECK_LEASE + `
if ARGV[3] == 'global' then
  redis.call('PEXPIRE', KEYS[1], ARGV[2])
else
  for i = 3, #KEYS do redis.call('PEXPIRE', KEYS[i], ARGV[2]) end
  redis.call('ZADD', KEYS[2], now + tonumber(ARGV[2]), ARGV[1])
  redis.call('PEXPIRE', KEYS[2], ARGV[2])
end
return 1
`

const RELEASE = `
if redis.call('GET', KEYS[1]) == ARGV[1] then redis.call('DEL', KEYS[1]) end
for i = 3, #KEYS do
  if redis.call('GET', KEYS[i]) == ARGV[1] then redis.call('DEL', KEYS[i]) end
end
redis.call('ZREM', KEYS[2], ARGV[1])
return 1
`

// values stay opaque strings in lua; all reads and validation precede mutation
const COMMIT = CHECK_LEASE + `
local count = tonumber(ARGV[4])
local entries = cjson.decode(ARGV[5])
local writes = {}
local deletes = {}
for i, entry in ipairs(entries) do
  local recordKey = KEYS[count + i * 2 - 1]
  local versionKey = KEYS[count + i * 2]
  local raw = redis.call('GET', recordKey)
  local version = redis.call('GET', versionKey)
  if (raw or cjson.null) ~= entry.raw or (version or cjson.null) ~= entry.rawVersion then
    return redis.error_reply('Record changed outside transaction locks')
  end
  if entry.mode == 'write' then
    writes[#writes + 1] = recordKey
    writes[#writes + 1] = entry.value
    writes[#writes + 1] = versionKey
    writes[#writes + 1] = entry.version
  elseif entry.mode == 'delete' then
    deletes[#deletes + 1] = recordKey
    deletes[#deletes + 1] = versionKey
  end
end
-- bounded chunks avoid lua's unpack limit; all command arguments are validated above
for i = 1, #writes, 1000 do redis.call('MSET', unpack(writes, i, math.min(i + 999, #writes))) end
for i = 1, #deletes, 1000 do redis.call('DEL', unpack(deletes, i, math.min(i + 999, #deletes))) end
return 1
`

export function validateRecordId(recordId) {
  if (typeof recordId !== "string" || recordId.length === 0) throw failure("Invalid recordId")
}

export function normalizeWrite(value, options = {}) {
  if (!options || typeof options !== "object" || Array.isArray(options)) throw failure("Invalid write options")
  const strategy = options.strategy ?? "replace"
  if (!["replace", "merge", "deepMerge"].includes(strategy)) throw failure("Invalid merge strategy")
  let serialized
  try { serialized = JSON.stringify(value) }
  catch { throw failure("Record value must be JSON serializable") }
  if (serialized === undefined) throw failure("Record value must be JSON serializable")
  return { value: JSON.parse(serialized), strategy }
}

export function resolveValue(oldValue, value, strategy) {
  if (strategy === "merge" && isObject(oldValue) && isObject(value)) return { ...oldValue, ...value }
  if (strategy === "deepMerge" && isObject(oldValue) && isObject(value)) return deepMerge(oldValue, value)
  return value
}

function patchValues(oldValue, newValue) {
  if (isDeepStrictEqual(oldValue, newValue)) return []
  if (oldValue === null || newValue === null || typeof oldValue !== "object" || typeof newValue !== "object" || Array.isArray(oldValue) !== Array.isArray(newValue)) {
    return [{ op: "replace", path: "", value: newValue }]
  }
  return jsonpatch.compare(oldValue, newValue)
}

/** Shared by ordinary mutations and transactions on every server instance. */
export function createRecordStore(redis, recordKey, versionKey) {
  async function withLock(records, fn) {
    if (scope.getStore()) throw failure("Use the transaction context instead of nested transactions or ordinary record writes")
    if (records !== undefined && !Array.isArray(records)) throw failure("records must be an array")
    records?.forEach(validateRecordId)
    const allowed = records === undefined ? null : new Set(records)
    const keys = [GLOBAL_LOCK, ACTIVE_LOCKS, ...[...(allowed ?? [])].sort().map(id => `${LOCK_PREFIX}${id}`)]
    const token = randomUUID()
    const mode = allowed === null ? "global" : "records"
    const args = [token, LEASE_MS, mode, keys.length]
    const deadline = Date.now() + ACQUIRE_TIMEOUT_MS
    let acquired = false
    try {
      while (!acquired) {
        acquired = await redis.eval(ACQUIRE, keys.length, ...keys, ...args) === 1
        if (acquired) break
        if (Date.now() >= deadline) throw failure("Timed out acquiring transaction lock")
        await new Promise(resolve => setTimeout(resolve, 25))
      }
      let lost = null
      let renewing = Promise.resolve()
      const timer = setInterval(() => {
        renewing = renewing.then(async () => {
          if (lost) return
          try { await redis.eval(RENEW, keys.length, ...keys, ...args) }
          catch (error) { lost = error }
        })
      }, LEASE_MS / 3)
      timer.unref()
      const lease = {
        allowed,
        assert() { if (lost) throw failure(`Transaction lock lost: ${lost.message}`) },
        async commit(entries) {
          this.assert()
          const storageKeys = entries.flatMap(entry => [recordKey(entry.recordId), versionKey(entry.recordId)])
          await redis.eval(COMMIT, keys.length + storageKeys.length, ...keys, ...storageKeys, ...args, JSON.stringify(entries))
        },
      }
      try { return await scope.run(lease, () => fn(lease)) }
      finally {
        clearInterval(timer)
        await renewing
      }
    } finally {
      // a timed-out acquire may still have reached redis; token checks make cleanup safe
      try { await redis.eval(RELEASE, keys.length, ...keys, token) }
      catch {}
    }
  }

  async function read(recordId) {
    const [raw, rawVersion] = await redis.mget(recordKey(recordId), versionKey(recordId))
    const version = rawVersion === null ? 0 : Number(rawVersion)
    if (!Number.isSafeInteger(version) || version < 0) throw failure(`Invalid record version for "${recordId}"`)
    return { recordId, raw, rawVersion, value: raw === null ? null : JSON.parse(raw), version }
  }

  function prepare(snapshot, staged) {
    if (staged?.mode === "delete" && snapshot.raw !== null) {
      return { entry: { ...snapshot, mode: "delete" }, change: { recordId: snapshot.recordId, deleted: true, version: snapshot.version, value: snapshot.value } }
    }
    if (staged?.mode === "write") {
      const finalValue = resolveValue(snapshot.value, staged.value, staged.strategy)
      const patch = patchValues(snapshot.value, finalValue)
      if (snapshot.raw === null || patch.length) {
        const version = snapshot.version + 1
        if (!Number.isSafeInteger(version)) throw failure(`Record version exhausted for "${snapshot.recordId}"`)
        return {
          entry: { ...snapshot, mode: "write", value: JSON.stringify(finalValue), version: String(version) },
          change: { recordId: snapshot.recordId, patch, version, finalValue },
        }
      }
    }
    return { entry: { ...snapshot, mode: "read" }, change: null }
  }

  return { withLock, read, prepare }
}
