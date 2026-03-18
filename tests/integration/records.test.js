import { describe, test, expect, beforeEach, afterEach } from "vitest"
import { RealtimeServer } from "../../src/index.js"
import { RealtimeClient } from "../../src/client/index.js"
import { createTestContext, wait } from "../helpers.js"

const ctx = createTestContext()

const createTestServer = (opts = {}) =>
  new RealtimeServer({ redis: ctx.redisOptions, ...opts })

describe("records", () => {
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

  test("subscribe to record and receive updates", async () => {
    server.exposeRecord(/^user:/)
    await server.listen(0)

    clientA = new RealtimeClient(`ws://localhost:${server.port}`)
    await clientA.connect()

    const updates = []
    const result = await clientA.subscribeRecord("user:123", (update) => {
      updates.push(update)
    })

    expect(result.success).toBe(true)

    await server.writeRecord("user:123", { name: "Alice", age: 30 })
    await wait(300)

    expect(updates.length).toBeGreaterThanOrEqual(1)
  })

  test("write record with merge strategy", async () => {
    server.exposeRecord(/^user:/)
    await server.listen(0)

    await server.writeRecord("user:456", { name: "Bob", age: 25 })
    await server.writeRecord("user:456", { age: 26 }, { strategy: "merge" })

    const record = await server.getRecord("user:456")
    expect(record.name).toBe("Bob")
    expect(record.age).toBe(26)
  })

  test("write record with deepMerge strategy", async () => {
    server.exposeRecord(/^user:/)
    await server.listen(0)

    await server.writeRecord("user:789", {
      name: "Carol",
      profile: { bio: "hello", settings: { theme: "dark" } },
    })
    await server.writeRecord(
      "user:789",
      { profile: { settings: { lang: "en" } } },
      { strategy: "deepMerge" }
    )

    const record = await server.getRecord("user:789")
    expect(record.name).toBe("Carol")
    expect(record.profile.bio).toBe("hello")
    expect(record.profile.settings.theme).toBe("dark")
    expect(record.profile.settings.lang).toBe("en")
  })

  test("delete record", async () => {
    server.exposeRecord(/^user:/)
    await server.listen(0)

    await server.writeRecord("user:del", { name: "to-delete" })
    const before = await server.getRecord("user:del")
    expect(before).toBeTruthy()

    await server.deleteRecord("user:del")
    const after = await server.getRecord("user:del")
    expect(after).toBeNull()
  })

  test("receives json diff patches in patch mode", async () => {
    server.exposeRecord(/^doc:/)
    await server.listen(0)

    await server.writeRecord("doc:1", { title: "hello", body: "world" })

    clientA = new RealtimeClient(`ws://localhost:${server.port}`)
    await clientA.connect()

    const allCallbacks = []
    const result = await clientA.subscribeRecord("doc:1", (update) => {
      allCallbacks.push(update)
    }, { mode: "patch" })

    expect(result.success).toBe(true)
    expect(result.record.title).toBe("hello")
    expect(result.version).toBe(1)

    // first callback is the initial subscription data (full record)
    expect(allCallbacks.length).toBe(1)

    await server.writeRecord("doc:1", { title: "updated", body: "world" })
    await wait(300)

    // second callback should be the patch update
    expect(allCallbacks.length).toBeGreaterThanOrEqual(2)
    const update = allCallbacks[1]
    expect(update.patch).toBeDefined()
    expect(update.version).toBe(2)
    expect(Array.isArray(update.patch)).toBe(true)
    expect(update.patch.length).toBeGreaterThan(0)

    const titlePatch = update.patch.find((op) => op.path === "/title")
    expect(titlePatch).toBeTruthy()
    expect(titlePatch.value).toBe("updated")
  })

  test("receives full record in full mode", async () => {
    server.exposeRecord(/^doc:/)
    await server.listen(0)

    await server.writeRecord("doc:2", { title: "original" })

    clientA = new RealtimeClient(`ws://localhost:${server.port}`)
    await clientA.connect()

    const allCallbacks = []
    await clientA.subscribeRecord("doc:2", (update) => {
      allCallbacks.push(update)
    })

    // first callback is initial subscription data
    expect(allCallbacks.length).toBe(1)
    expect(allCallbacks[0].full.title).toBe("original")

    await server.writeRecord("doc:2", { title: "changed" })
    await wait(300)

    // second callback should be the update
    expect(allCallbacks.length).toBeGreaterThanOrEqual(2)
    expect(allCallbacks[1].full).toBeDefined()
    expect(allCallbacks[1].full.title).toBe("changed")
    expect(allCallbacks[1].version).toBe(2)
  })

  test("patch mode re-syncs on version gap", async () => {
    server.exposeRecord(/^sync:/)
    await server.listen(0)

    await server.writeRecord("sync:1", { v: "initial" })

    clientA = new RealtimeClient(`ws://localhost:${server.port}`)
    await clientA.connect()

    const allCallbacks = []
    await clientA.subscribeRecord("sync:1", (update) => {
      allCallbacks.push(update)
    }, { mode: "patch" })

    // first callback is initial subscription (full record, version 1)
    expect(allCallbacks.length).toBe(1)
    expect(allCallbacks[0].version).toBe(1)

    // simulate a version gap: write v2 and v3 rapidly
    // the client should get v2 normally, then v3 normally,
    // OR if it misses v2, it should detect the gap and resubscribe
    await server.writeRecord("sync:1", { v: "second" })
    await server.writeRecord("sync:1", { v: "third" })
    await wait(500)

    // regardless of whether patches or resync happened,
    // the client should have the latest version
    const lastCallback = allCallbacks[allCallbacks.length - 1]
    expect(lastCallback.version).toBeGreaterThanOrEqual(2)

    // verify the client's internal state is correct by subscribing to
    // another update and confirming it arrives
    await server.writeRecord("sync:1", { v: "fourth" })
    await wait(300)

    const latestCallback = allCallbacks[allCallbacks.length - 1]
    if (latestCallback.full) {
      expect(latestCallback.full.v).toBe("fourth")
    } else if (latestCallback.patch) {
      expect(latestCallback.version).toBe(4)
    }
  })

  test("forced version gap triggers resubscribe in patch mode", async () => {
    server.exposeRecord(/^gap:/)
    await server.listen(0)

    await server.writeRecord("gap:1", { count: 0 })

    clientA = new RealtimeClient(`ws://localhost:${server.port}`)
    await clientA.connect()

    const allCallbacks = []
    await clientA.subscribeRecord("gap:1", (update) => {
      allCallbacks.push(update)
    }, { mode: "patch" })

    // initial subscribe callback
    expect(allCallbacks.length).toBe(1)

    // write directly to redis to skip a version, creating a gap
    // v2: normal write
    await server.writeRecord("gap:1", { count: 1 })
    await wait(200)

    // now manually bump version in redis to v5 without going through v3,v4
    const redis = server.recordManager.getRedis()
    await redis.set("mesh:record:gap:1", JSON.stringify({ count: 99 }))
    await redis.set("mesh:record-version:gap:1", "5")

    // publish a fake update at v5 - client has v2, expects v3, gets v5
    await server.recordSubscriptionManager.pubClient.publish(
      "mesh:record-updates",
      JSON.stringify({
        recordId: "gap:1",
        newValue: { count: 99 },
        patch: [{ op: "replace", path: "/count", value: 99 }],
        version: 5,
      })
    )
    await wait(500)

    // the client should have detected the gap and resubscribed
    // look for a callback with full record (resubscribe result)
    const resubCallbacks = allCallbacks.filter((c) => c.full && c.version >= 5)
    expect(resubCallbacks.length).toBeGreaterThanOrEqual(1)
    expect(resubCallbacks[0].full.count).toBe(99)
  })

  test("unexposed record returns failure", async () => {
    await server.listen(0)

    clientA = new RealtimeClient(`ws://localhost:${server.port}`)
    await clientA.connect()

    const result = await clientA.subscribeRecord("secret:data", () => {})
    expect(result.success).toBe(false)
  })

  test("writable record allows client writes", async () => {
    server.exposeWritableRecord(/^profile:/)
    await server.listen(0)

    clientA = new RealtimeClient(`ws://localhost:${server.port}`)
    await clientA.connect()

    await clientA.subscribeRecord("profile:user1", () => {})
    const writeResult = await clientA.command("mesh/publish-record-update", {
      recordId: "profile:user1",
      newValue: { name: "Test" },
    })

    expect(writeResult.success).toBe(true)

    const record = await server.getRecord("profile:user1")
    expect(record.name).toBe("Test")
  })

  test("onRecordUpdate callback fires", async () => {
    server.exposeRecord(/^item:/)
    await server.listen(0)

    const updates = []
    server.onRecordUpdate(({ recordId, value }) => {
      updates.push({ recordId, value })
    })

    await server.writeRecord("item:1", { count: 1 })
    await wait(100)

    expect(updates.length).toBe(1)
    expect(updates[0].recordId).toBe("item:1")
    expect(updates[0].value.count).toBe(1)
  })
})
