import { describe, test, expect, beforeEach, afterEach } from "vitest"
import { RealtimeServer } from "../../src/index.js"
import { RealtimeClient } from "../../src/client/index.js"
import { PersistenceManager } from "../../src/server/managers/persistence.js"
import { createTestContext, wait } from "../helpers.js"

const ctx = createTestContext()

// in-memory adapter that survives across server instances (the test holds the
// reference), so a new server reading from it simulates a process restart
function createMemoryAdapter() {
  const records = new Map()
  const messages = []
  const globToRegExp = (pattern) =>
    new RegExp(`^${pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`)
  return {
    records,
    async initialize() {},
    async storeMessages(batch) { messages.push(...batch) },
    async getMessages() { return messages },
    async storeRecords(batch) {
      for (const r of batch) records.set(r.recordId, { recordId: r.recordId, value: r.value, version: r.version })
    },
    async removeRecords(ids) {
      for (const id of ids) records.delete(id)
    },
    async getRecords(pattern) {
      const re = globToRegExp(pattern)
      return [...records.values()].filter((r) => re.test(r.recordId))
    },
    async close() {},
  }
}

describe("PersistenceManager record deletion", () => {
  test("flushes deletes to the adapter and a delete supersedes a buffered write", async () => {
    const adapter = createMemoryAdapter()
    const pm = new PersistenceManager({ adapter })
    await pm.initialize()
    pm.enableRecordPersistence({ pattern: /^item:/, adapter: { restorePattern: "item:*" }, flushInterval: 50 })

    pm.handleRecordUpdate("item:1", { name: "one" }, 1)
    pm.handleRecordUpdate("item:2", { name: "two" }, 1)
    await pm.flushRecords()
    expect(adapter.records.has("item:1")).toBe(true)
    expect(adapter.records.has("item:2")).toBe(true)

    pm.handleRecordRemoved("item:1")
    await pm.flushRecords()
    expect(adapter.records.has("item:1")).toBe(false)
    expect(adapter.records.has("item:2")).toBe(true)

    // write then delete in the same window: delete wins, nothing is stored
    pm.handleRecordUpdate("item:3", { name: "three" }, 1)
    pm.handleRecordRemoved("item:3")
    await pm.flushRecords()
    expect(adapter.records.has("item:3")).toBe(false)

    await pm.shutdown()
  })

  test("a write after a delete in the same window supersedes the delete", async () => {
    const adapter = createMemoryAdapter()
    const pm = new PersistenceManager({ adapter })
    await pm.initialize()
    pm.enableRecordPersistence({ pattern: /^item:/, adapter: { restorePattern: "item:*" }, flushInterval: 50 })

    pm.handleRecordUpdate("item:1", { name: "one" }, 1)
    await pm.flushRecords()

    pm.handleRecordRemoved("item:1")
    pm.handleRecordUpdate("item:1", { name: "one-again" }, 2)
    await pm.flushRecords()
    expect(adapter.records.has("item:1")).toBe(true)
    expect(JSON.parse(adapter.records.get("item:1").value)).toEqual({ name: "one-again" })

    await pm.shutdown()
  })
})

describe("deleted records are not resurrected on restart", () => {
  let server
  let clientA
  let adapter

  beforeEach(async () => {
    await ctx.flush()
    adapter = createMemoryAdapter()
  })

  afterEach(async () => {
    if (clientA) { await clientA.close(); clientA = null }
    if (server) { await server.close(); server = null }
  })

  const boot = async () => {
    const s = new RealtimeServer({ redis: ctx.redisOptions, persistence: adapter })
    s.exposeRecord(/^item:/)
    s.enableRecordPersistence({ pattern: /^item:/, adapter: { restorePattern: "item:*" }, flushInterval: 50 })
    s.exposeCollection(/^items:/, async () => s.listRecordsMatching("item:*"))
    await s.listen(0)
    return s
  }

  test("a record deleted before restart stays gone after restart", async () => {
    server = await boot()
    await server.writeRecord("item:1", { id: "item:1", name: "keeper" })
    await server.writeRecord("item:2", { id: "item:2", name: "doomed" })
    await wait(150)
    expect(adapter.records.has("item:1")).toBe(true)
    expect(adapter.records.has("item:2")).toBe(true)

    await server.deleteRecord("item:2")
    await wait(150)
    expect(adapter.records.has("item:2")).toBe(false)

    // restart: same durable adapter, fresh redis-backed server
    await server.close()
    await ctx.flush()
    server = await boot()
    await wait(150)

    clientA = new RealtimeClient(`ws://localhost:${server.port}`)
    await clientA.connect()
    const result = await clientA.subscribeCollection("items:all")

    expect(result.success).toBe(true)
    expect(result.ids).toContain("item:1")
    expect(result.ids).not.toContain("item:2")
    expect(await server.getRecord("item:2")).toBe(null)
  })
})
