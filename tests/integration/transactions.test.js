import { describe, test, expect, beforeEach, afterEach } from "vitest"
import { RealtimeServer } from "../../src/index.js"
import { RealtimeClient } from "../../src/client/index.js"
import { createTestContext, wait } from "../helpers.js"

const ctx = createTestContext()

const createTestServer = (opts = {}) =>
  new RealtimeServer({ redis: ctx.redisOptions, ...opts })

describe("transactions", () => {
  let server
  let clientA
  let clientB

  beforeEach(async () => {
    await ctx.flush()
    server = createTestServer()
  })

  afterEach(async () => {
    if (clientA) await clientA.close()
    if (clientB) await clientB.close()
    if (server) await server.close()
  })

  test("server.transaction commits all writes atomically", async () => {
    server.exposeRecord(/^tx:/)
    await server.listen(0)

    const { id, result, changes } = await server.transaction(async (tx) => {
      tx.writeRecord("tx:1", { count: 1 })
      tx.writeRecord("tx:2", { count: 2 })
      return { done: true }
    })

    expect(result.done).toBe(true)
    expect(id).toBeTruthy()
    expect(changes.length).toBe(2)
    expect(await server.getRecord("tx:1")).toEqual({ count: 1 })
    expect(await server.getRecord("tx:2")).toEqual({ count: 2 })
  })

  test("reads inside the transaction see staged writes (read-your-writes)", async () => {
    server.exposeRecord(/^tx:/)
    await server.listen(0)
    await server.writeRecord("tx:acc", { balance: 100 })

    const { result } = await server.transaction(async (tx) => {
      tx.writeRecord("tx:acc", { balance: 150 }, { strategy: "merge" })
      const balance = await tx.getRecord("tx:acc")
      return { balance: balance.balance }
    })

    expect(result.balance).toBe(150)
    expect(await server.getRecord("tx:acc")).toEqual({ balance: 150 })
  })

  test("transaction with empty body commits without changing records", async () => {
    await server.listen(0)
    const { id, changes } = await server.transaction(async () => 42)
    expect(changes).toEqual([])
    expect(id).toBeTruthy()
  })

  test("client.transaction commits the batch and bumps versions", async () => {
    server.exposeRecord(/^profile:/)
    server.exposeWritableRecord(/^profile:/)
    await server.listen(0)

    clientA = new RealtimeClient(`ws://localhost:${server.port}`)
    await clientA.connect()

    const { id, results } = await clientA.transaction([
      { op: "write", recordId: "profile:1", value: { name: "Ada" } },
      { op: "write", recordId: "profile:2", value: { name: "Grace" } },
      { op: "delete", recordId: "profile:gone" },
    ])

    expect(id).toBeTruthy()
    expect(results).toHaveLength(3)
    expect(results.every((r) => r.success)).toBe(true)
    expect(results[0].version).toBe(1)
    expect(results[1].version).toBe(1)
    expect(await server.getRecord("profile:1")).toEqual({ name: "Ada" })
    expect(await server.getRecord("profile:2")).toEqual({ name: "Grace" })
    expect(await server.getRecord("profile:gone")).toBeNull()
  })

  test("client.transaction rejects when a record is not writable", async () => {
    server.exposeRecord(/^readonly:/)
    await server.listen(0)

    clientA = new RealtimeClient(`ws://localhost:${server.port}`)
    await clientA.connect()

    await expect(
      clientA.transaction([{ op: "write", recordId: "readonly:1", value: { x: 1 } }])
    ).rejects.toThrow(/not writable/i)
    expect(await server.getRecord("readonly:1")).toBeNull()
  })

  test("client.transaction validates operation shape", async () => {
    server.exposeWritableRecord(/^profile:/)
    await server.listen(0)

    clientA = new RealtimeClient(`ws://localhost:${server.port}`)
    await clientA.connect()

    await expect(clientA.transaction([])).rejects.toThrow(/non-empty/i)
    await expect(
      clientA.transaction([{ op: "bogus", recordId: "profile:1" }])
    ).rejects.toThrow(/invalid transaction operation/i)
  })

  test("merge strategy is applied per record inside a transaction", async () => {
    server.exposeRecord(/^tx:/)
    await server.listen(0)
    await server.writeRecord("tx:acc", { balance: 100, name: "keep" })

    await server.transaction(async (tx) => {
      tx.writeRecord("tx:acc", { balance: 250 }, { strategy: "merge" })
    })

    const record = await server.getRecord("tx:acc")
    expect(record.balance).toBe(250)
    expect(record.name).toBe("keep")
  })

  test("subscribers receive updates and deletions from a transaction", async () => {
    server.exposeRecord(/^tx:/)
    await server.listen(0)
    await server.writeRecord("tx:sub", { v: 0 })
    await server.writeRecord("tx:gone", { v: 0 })

    clientA = new RealtimeClient(`ws://localhost:${server.port}`)
    await clientA.connect()

    const updates = []
    const deleted = []
    await clientA.subscribeRecord("tx:sub", (update) => {
      if (update.deleted) deleted.push(update)
      else updates.push(update)
    })
    // the deleted record's subscription is torn down on delete, so track it separately
    const deletedEvents = []
    await clientA.subscribeRecord("tx:gone", (update) => {
      if (update.deleted) deletedEvents.push(update)
    })

    await server.transaction(async (tx) => {
      tx.writeRecord("tx:sub", { v: 1 })
      tx.deleteRecord("tx:gone")
    })
    await wait(300)

    expect(updates.length).toBeGreaterThanOrEqual(1)
    expect(updates.some((u) => u.full?.v === 1)).toBe(true)
    expect(deletedEvents.length).toBe(1)
  })

  test("concurrent transactions on the same record serialize and all commit", async () => {
    server.exposeRecord(/^tx:/)
    await server.listen(0)
    await server.writeRecord("tx:counter", { count: 0 })

    // each transaction reads the live value under the record lock, so the
    // 5 increments serialize: final value is exactly 5, and each result
    // reflects a distinct intermediate count (1..5 in some order)
    const txs = await Promise.all(
      Array.from({ length: 5 }, () =>
        server.transaction(async (tx) => {
          const current = await tx.getRecord("tx:counter")
          tx.writeRecord("tx:counter", { count: (current?.count ?? 0) + 1 })
          return { count: (current?.count ?? 0) + 1 }
        }, { records: ["tx:counter"] })
      )
    )

    const final = await server.getRecord("tx:counter")
    expect(final.count).toBe(5)
    const counts = txs.map(({ result }) => result.count).sort((a, b) => a - b)
    expect(counts).toEqual([1, 2, 3, 4, 5])
  })

  test("transaction callback runs exactly once (no re-execution)", async () => {
    server.exposeRecord(/^tx:/)
    await server.listen(0)

    let runs = 0
    await server.transaction(async (tx) => {
      runs += 1
      tx.writeRecord("tx:once", { runs })
    }, { records: ["tx:once"] })

    expect(runs).toBe(1)
    expect(await server.getRecord("tx:once")).toEqual({ runs: 1 })
  })

  test("transactions on disjoint records run concurrently", async () => {
    server.exposeRecord(/^tx:/)
    await server.listen(0)
    await server.writeRecord("tx:left", { count: 0 })
    await server.writeRecord("tx:right", { count: 0 })

    const [left, right] = await Promise.all([
      server.transaction(async (tx) => {
        const current = await tx.getRecord("tx:left")
        tx.writeRecord("tx:left", { count: current.count + 1 })
      }, { records: ["tx:left"] }),
      server.transaction(async (tx) => {
        const current = await tx.getRecord("tx:right")
        tx.writeRecord("tx:right", { count: current.count + 1 })
      }, { records: ["tx:right"] }),
    ])

    expect(left.changes).toHaveLength(1)
    expect(right.changes).toHaveLength(1)
    expect(await server.getRecord("tx:left")).toEqual({ count: 1 })
    expect(await server.getRecord("tx:right")).toEqual({ count: 1 })
  })

  test("valid batch writes a record and ignores a missing deletion", async () => {
    server.exposeRecord(/^tx:/)
    server.exposeWritableRecord(/^tx:/)
    await server.listen(0)

    clientA = new RealtimeClient(`ws://localhost:${server.port}`)
    await clientA.connect()

    await clientA.transaction([
      { op: "write", recordId: "tx:a", value: { x: 1 } },
      { op: "delete", recordId: "tx:b" },
    ])

    expect(await server.getRecord("tx:a")).toEqual({ x: 1 })
    expect(await server.getRecord("tx:b")).toBeNull()
  })
})