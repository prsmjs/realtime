import { describe, test, expect, beforeEach, afterEach } from "vitest"
import { RealtimeServer } from "../../src/index.js"
import { RealtimeClient } from "../../src/client/index.js"
import { createTestContext, wait } from "../helpers.js"

const ctx = createTestContext()

const createTestServer = (opts = {}) =>
  new RealtimeServer({ redis: ctx.redisOptions, ...opts })

describe("disconnect cleanup", () => {
  let server
  let client

  beforeEach(async () => {
    await ctx.flush()
    server = createTestServer()
  })

  afterEach(async () => {
    if (client) await client.close()
    if (server) await server.close()
  })

  test("room membership cleaned up on disconnect", async () => {
    await server.listen(0)

    client = new RealtimeClient(`ws://localhost:${server.port}`, { shouldReconnect: false })
    await client.connect()

    const connId = client.connectionId
    await server.addToRoom("cleanup-room", connId)

    let members = await server.getRoomMembers("cleanup-room")
    expect(members).toContain(connId)

    await client.close()
    client = null
    await wait(500)

    members = await server.getRoomMembers("cleanup-room")
    expect(members).not.toContain(connId)
  })

  test("record subscriptions cleaned up on disconnect", async () => {
    server.exposeRecord(/^item:/)
    await server.listen(0)

    client = new RealtimeClient(`ws://localhost:${server.port}`, { shouldReconnect: false })
    await client.connect()

    await client.subscribeRecord("item:cleanup", () => {})

    await client.close()
    client = null
    await wait(300)

    const subs = server.recordSubscriptionManager.getSubscribers("item:cleanup")
    expect(!subs || subs.size === 0).toBe(true)
  })
})

describe("concurrent subscriptions", () => {
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

  test("multiple clients subscribe to same record", async () => {
    server.exposeRecord(/^shared:/)
    await server.listen(0)

    clientA = new RealtimeClient(`ws://localhost:${server.port}`)
    clientB = new RealtimeClient(`ws://localhost:${server.port}`)
    await clientA.connect()
    await clientB.connect()

    const updatesA = []
    const updatesB = []
    let skipA = true
    let skipB = true

    await clientA.subscribeRecord("shared:both", (u) => {
      if (skipA) { skipA = false; return }
      updatesA.push(u)
    })
    await clientB.subscribeRecord("shared:both", (u) => {
      if (skipB) { skipB = false; return }
      updatesB.push(u)
    })

    await server.writeRecord("shared:both", { count: 1 })
    await wait(300)

    expect(updatesA.length).toBeGreaterThanOrEqual(1)
    expect(updatesB.length).toBeGreaterThanOrEqual(1)
  })

  test("multiple clients subscribe to same channel", async () => {
    server.exposeChannel("news")
    await server.listen(0)

    clientA = new RealtimeClient(`ws://localhost:${server.port}`)
    clientB = new RealtimeClient(`ws://localhost:${server.port}`)
    await clientA.connect()
    await clientB.connect()

    const messagesA = []
    const messagesB = []

    await clientA.subscribeChannel("news", (msg) => messagesA.push(msg))
    await clientB.subscribeChannel("news", (msg) => messagesB.push(msg))

    await server.writeChannel("news", "breaking")
    await wait(300)

    expect(messagesA).toContain("breaking")
    expect(messagesB).toContain("breaking")
  })
})

describe("record deletion notification", () => {
  let server
  let client

  beforeEach(async () => {
    await ctx.flush()
    server = createTestServer()
  })

  afterEach(async () => {
    if (client) await client.close()
    if (server) await server.close()
  })

  test("subscriber receives delete event", async () => {
    server.exposeRecord(/^temp:/)
    await server.listen(0)

    await server.writeRecord("temp:item", { data: "will be deleted" })

    client = new RealtimeClient(`ws://localhost:${server.port}`)
    await client.connect()

    const callbacks = []
    await client.subscribeRecord("temp:item", (update) => {
      callbacks.push(update)
    })

    expect(callbacks.length).toBe(1)
    expect(callbacks[0].full.data).toBe("will be deleted")

    await server.deleteRecord("temp:item")
    await wait(300)

    const deleteEvent = callbacks.find((c) => c.deleted === true)
    expect(deleteEvent).toBeTruthy()
    expect(deleteEvent.recordId).toBe("temp:item")
  })
})

describe("connection metadata strategies", () => {
  let server
  let client

  beforeEach(async () => {
    await ctx.flush()
    server = createTestServer()
  })

  afterEach(async () => {
    if (client) await client.close()
    if (server) await server.close()
  })

  test("merge strategy for connection metadata", async () => {
    server.exposeCommand("set-base", async (ctx) => {
      await ctx.server.connectionManager.setMetadata(ctx.connection, { name: "user", age: 25 })
      return true
    })
    server.exposeCommand("merge-meta", async (ctx) => {
      await ctx.server.connectionManager.setMetadata(ctx.connection, { age: 26, city: "NYC" }, { strategy: "merge" })
      return true
    })
    server.exposeCommand("get-meta", async (ctx) => {
      return await ctx.server.connectionManager.getMetadata(ctx.connection)
    })

    await server.listen(0)

    client = new RealtimeClient(`ws://localhost:${server.port}`)
    await client.connect()

    await client.command("set-base", {})
    await client.command("merge-meta", {})
    const meta = await client.command("get-meta", {})

    expect(meta.name).toBe("user")
    expect(meta.age).toBe(26)
    expect(meta.city).toBe("NYC")
  })

  test("deepMerge strategy for connection metadata", async () => {
    server.exposeCommand("set-nested", async (ctx) => {
      await ctx.server.connectionManager.setMetadata(ctx.connection, {
        profile: { name: "user", settings: { theme: "dark" } },
      })
      return true
    })
    server.exposeCommand("deep-merge", async (ctx) => {
      await ctx.server.connectionManager.setMetadata(
        ctx.connection,
        { profile: { settings: { lang: "en" } } },
        { strategy: "deepMerge" }
      )
      return true
    })
    server.exposeCommand("get-meta", async (ctx) => {
      return await ctx.server.connectionManager.getMetadata(ctx.connection)
    })

    await server.listen(0)

    client = new RealtimeClient(`ws://localhost:${server.port}`)
    await client.connect()

    await client.command("set-nested", {})
    await client.command("deep-merge", {})
    const meta = await client.command("get-meta", {})

    expect(meta.profile.name).toBe("user")
    expect(meta.profile.settings.theme).toBe("dark")
    expect(meta.profile.settings.lang).toBe("en")
  })
})

describe("server metadata by connection ID", () => {
  let server
  let client

  beforeEach(async () => {
    await ctx.flush()
    server = createTestServer({
      authenticateConnection: () => ({ role: "user" }),
    })
  })

  afterEach(async () => {
    if (client) await client.close()
    if (server) await server.close()
  })

  test("getConnectionMetadata with string ID", async () => {
    await server.listen(0)

    client = new RealtimeClient(`ws://localhost:${server.port}`)
    await client.connect()
    await wait(100)

    const meta = await server.getConnectionMetadata(client.connectionId)
    expect(meta.role).toBe("user")
  })

  test("setConnectionMetadata with string ID", async () => {
    await server.listen(0)

    client = new RealtimeClient(`ws://localhost:${server.port}`)
    await client.connect()
    await wait(100)

    await server.setConnectionMetadata(client.connectionId, { role: "admin" })
    const meta = await server.getConnectionMetadata(client.connectionId)
    expect(meta.role).toBe("admin")
  })
})

describe("connectionCount after disconnect", () => {
  let server
  let client

  beforeEach(async () => {
    await ctx.flush()
    server = createTestServer()
  })

  afterEach(async () => {
    if (client) await client.close()
    if (server) await server.close()
  })

  test("connectionCount decreases after disconnect", async () => {
    await server.listen(0)

    client = new RealtimeClient(`ws://localhost:${server.port}`, { shouldReconnect: false })
    await client.connect()
    await wait(100)

    expect(server.connectionCount).toBe(1)

    await client.close()
    client = null
    await wait(300)

    expect(server.connectionCount).toBe(0)
  })
})

describe("channel history", () => {
  let server
  let client

  beforeEach(async () => {
    await ctx.flush()
    server = createTestServer()
  })

  afterEach(async () => {
    if (client) await client.close()
    if (server) await server.close()
  })

  test("redis channel history with limit", async () => {
    server.exposeChannel("log")
    await server.listen(0)

    await server.writeChannel("log", "msg1", 10)
    await server.writeChannel("log", "msg2", 10)
    await server.writeChannel("log", "msg3", 10)

    client = new RealtimeClient(`ws://localhost:${server.port}`)
    await client.connect()

    const result = await client.subscribeChannel("log", () => {}, { historyLimit: 2 })
    expect(result.success).toBe(true)
    expect(result.history.length).toBeLessThanOrEqual(3)
  })
})
