import { describe, test, expect, beforeEach, afterEach } from "vitest"
import { RealtimeServer } from "../../src/index.js"
import { RealtimeClient } from "../../src/client/index.js"
import { createTestContext, wait } from "../helpers.js"

const ctx = createTestContext()

const createTestServer = (opts = {}) =>
  new RealtimeServer({ redis: ctx.redisOptions, ...opts })

describe("collections", () => {
  let server
  let clientA

  beforeEach(async () => {
    await ctx.flush()
    server = createTestServer()
  })

  afterEach(async () => {
    if (clientA) await clientA.close()
    if (server) await server.close()
  })

  test("subscribe to collection and get initial records", async () => {
    server.exposeRecord(/^item:/)
    server.exposeCollection(/^items:/, async (connection, collectionId) => {
      return await server.listRecordsMatching("item:*", {
        sort: (a, b) => a.order - b.order,
      })
    })

    await server.listen(0)

    await server.writeRecord("item:1", { id: "item:1", name: "first", order: 1 })
    await server.writeRecord("item:2", { id: "item:2", name: "second", order: 2 })

    clientA = new RealtimeClient(`ws://localhost:${server.port}`)
    await clientA.connect()

    const result = await clientA.subscribeCollection("items:all")
    expect(result.success).toBe(true)
    expect(result.ids.length).toBe(2)
    expect(result.records.length).toBe(2)
    expect(result.version).toBe(1)
  })

  test("collection diff on record add", async () => {
    server.exposeRecord(/^item:/)
    server.exposeWritableRecord(/^item:/)
    server.exposeCollection(/^items:/, async (connection, collectionId) => {
      return await server.listRecordsMatching("item:*")
    })

    await server.listen(0)

    await server.writeRecord("item:a", { id: "item:a", name: "alpha" })

    clientA = new RealtimeClient(`ws://localhost:${server.port}`)
    await clientA.connect()

    const diffs = []
    const result = await clientA.subscribeCollection("items:list", {
      onDiff: (diff) => diffs.push(diff),
    })

    expect(result.success).toBe(true)
    expect(result.ids.length).toBe(1)

    await server.writeRecord("item:b", { id: "item:b", name: "beta" })
    await wait(800)

    expect(diffs.length).toBeGreaterThanOrEqual(1)
    const allAdded = diffs.flatMap((d) => d.added || [])
    const addedIds = allAdded.map((r) => r.id)
    expect(addedIds).toContain("item:b")
  })

  test("collection diff on record remove", async () => {
    server.exposeRecord(/^item:/)
    server.exposeCollection(/^items:/, async () => {
      return await server.listRecordsMatching("item:*")
    })

    await server.listen(0)

    await server.writeRecord("item:x", { id: "item:x", name: "to-remove" })
    await server.writeRecord("item:y", { id: "item:y", name: "keeper" })

    clientA = new RealtimeClient(`ws://localhost:${server.port}`)
    await clientA.connect()

    const diffs = []
    await clientA.subscribeCollection("items:test", {
      onDiff: (diff) => diffs.push(diff),
    })

    await server.deleteRecord("item:x")
    await wait(500)

    expect(diffs.length).toBeGreaterThanOrEqual(1)
    const removeDiff = diffs.find((d) =>
      d.removed.some((r) => r.id === "item:x")
    )
    expect(removeDiff).toBeTruthy()
  })

  test("unexposed collection returns failure", async () => {
    await server.listen(0)

    clientA = new RealtimeClient(`ws://localhost:${server.port}`)
    await clientA.connect()

    const result = await clientA.subscribeCollection("secret:collection")
    expect(result.success).toBe(false)
  })

  test("listRecordsMatching with map/sort/slice", async () => {
    server.exposeRecord(/^task:/)
    await server.listen(0)

    await server.writeRecord("task:1", { id: "task:1", title: "C task", priority: 3 })
    await server.writeRecord("task:2", { id: "task:2", title: "A task", priority: 1 })
    await server.writeRecord("task:3", { id: "task:3", title: "B task", priority: 2 })

    const result = await server.listRecordsMatching("task:*", {
      sort: (a, b) => a.priority - b.priority,
      slice: { start: 0, count: 2 },
    })

    expect(result.length).toBe(2)
    expect(result[0].priority).toBe(1)
    expect(result[1].priority).toBe(2)
  })
})
