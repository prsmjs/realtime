import { describe, test, expect, beforeEach, afterEach } from "vitest"
import { RealtimeServer } from "../../src/index.js"
import { RealtimeClient } from "../../src/client/index.js"
import { createTestContext, wait } from "../helpers.js"

const ctx = createTestContext()

const createTestServer = (opts = {}) =>
  new RealtimeServer({ redis: ctx.redisOptions, ...opts })

describe("connect", () => {
  let server
  let client

  beforeEach(async () => {
    await ctx.flush()
  })

  afterEach(async () => {
    if (client) await client.close()
    if (server) await server.close()
  })

  test("client connects to server", async () => {
    server = createTestServer()
    await server.listen(0)

    client = new RealtimeClient(`ws://localhost:${server.port}`)
    await client.connect()

    expect(client.connectionId).toBeDefined()
    expect(client.status).toBe(3) // Status.ONLINE
  })

  test("server assigns connection id", async () => {
    server = createTestServer()
    await server.listen(0)

    client = new RealtimeClient(`ws://localhost:${server.port}`)
    await client.connect()

    const id = client.connectionId
    expect(id).toBeTruthy()
    expect(typeof id).toBe("string")
  })

  test("onConnection callback fires", async () => {
    server = createTestServer()

    let connectedId
    server.onConnection((connection) => {
      connectedId = connection.id
    })

    await server.listen(0)

    client = new RealtimeClient(`ws://localhost:${server.port}`)
    await client.connect()
    await wait(100)

    expect(connectedId).toBeTruthy()
    expect(connectedId).toBe(client.connectionId)
  })

  test("onDisconnection callback fires", async () => {
    server = createTestServer()

    let disconnectedId
    server.onDisconnection((connection) => {
      disconnectedId = connection.id
    })

    await server.listen(0)

    client = new RealtimeClient(`ws://localhost:${server.port}`, { shouldReconnect: false })
    await client.connect()
    const id = client.connectionId

    await client.close()
    await wait(200)

    expect(disconnectedId).toBe(id)
    client = null
  })
})

describe("commands", () => {
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

  test("exposeCommand and client.command round trip", async () => {
    server.exposeCommand("echo", (ctx) => ({ youSent: ctx.payload }))
    await server.listen(0)

    client = new RealtimeClient(`ws://localhost:${server.port}`)
    await client.connect()

    const result = await client.command("echo", { hello: "world" })
    expect(result.youSent).toEqual({ hello: "world" })
  })

  test("command not found returns error payload", async () => {
    await server.listen(0)

    client = new RealtimeClient(`ws://localhost:${server.port}`)
    await client.connect()

    const result = await client.command("nonexistent", {})
    expect(result.error).toContain("not found")
    expect(result.code).toBe("ENOTFOUND")
  })

  test("command error returns error payload", async () => {
    server.exposeCommand("fail", () => {
      throw new Error("intentional error")
    })
    await server.listen(0)

    client = new RealtimeClient(`ws://localhost:${server.port}`)
    await client.connect()

    const result = await client.command("fail", {})
    expect(result.error).toBe("intentional error")
  })
})

describe("metadata", () => {
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

  test("set and get connection metadata", async () => {
    server.exposeCommand("set-meta", async (ctx) => {
      await ctx.server.connectionManager.setMetadata(ctx.connection, { name: "test-user" })
      return true
    })

    server.exposeCommand("get-meta", async (ctx) => {
      return await ctx.server.connectionManager.getMetadata(ctx.connection)
    })

    await server.listen(0)

    client = new RealtimeClient(`ws://localhost:${server.port}`)
    await client.connect()

    await client.command("set-meta", {})
    const meta = await client.command("get-meta", {})
    expect(meta.name).toBe("test-user")
  })

  test("authenticateConnection sets initial metadata", async () => {
    server = createTestServer({
      authenticateConnection: () => ({ role: "admin" }),
    })

    server.exposeCommand("whoami", async (ctx) => {
      return await ctx.server.connectionManager.getMetadata(ctx.connection)
    })

    await server.listen(0)

    client = new RealtimeClient(`ws://localhost:${server.port}`)
    await client.connect()

    const meta = await client.command("whoami", {})
    expect(meta.role).toBe("admin")
  })

  test("authenticateConnection rejection", async () => {
    server = createTestServer({
      authenticateConnection: () => {
        throw { code: 403, message: "forbidden" }
      },
    })
    await server.listen(0)

    client = new RealtimeClient(`ws://localhost:${server.port}`, { shouldReconnect: false })

    await expect(client.connect()).rejects.toThrow()
    client = null
  })
})

describe("connection count", () => {
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

  test("connectionCount tracks local connections", async () => {
    await server.listen(0)

    expect(server.connectionCount).toBe(0)

    clientA = new RealtimeClient(`ws://localhost:${server.port}`)
    await clientA.connect()
    await wait(100)

    expect(server.connectionCount).toBe(1)

    clientB = new RealtimeClient(`ws://localhost:${server.port}`)
    await clientB.connect()
    await wait(100)

    expect(server.connectionCount).toBe(2)
  })

  test("totalConnectionCount returns count across instances", async () => {
    await server.listen(0)

    clientA = new RealtimeClient(`ws://localhost:${server.port}`)
    await clientA.connect()
    await wait(100)

    const total = await server.totalConnectionCount()
    expect(total).toBe(1)
  })
})

describe("ctx helpers", () => {
  let server
  let client

  beforeEach(async () => {
    await ctx.flush()
    server = createTestServer({
      authenticateConnection: () => ({ role: "admin" }),
    })
  })

  afterEach(async () => {
    if (client) await client.close()
    if (server) await server.close()
  })

  test("ctx.getMetadata() shorthand", async () => {
    server.exposeCommand("whoami", async (ctx) => {
      return await ctx.getMetadata()
    })
    await server.listen(0)

    client = new RealtimeClient(`ws://localhost:${server.port}`)
    await client.connect()

    const meta = await client.command("whoami", {})
    expect(meta.role).toBe("admin")
  })

  test("ctx.setMetadata() shorthand", async () => {
    server.exposeCommand("update-role", async (ctx) => {
      await ctx.setMetadata({ role: "superadmin" }, { strategy: "merge" })
      return await ctx.getMetadata()
    })
    await server.listen(0)

    client = new RealtimeClient(`ws://localhost:${server.port}`)
    await client.connect()

    const meta = await client.command("update-role", {})
    expect(meta.role).toBe("superadmin")
  })
})

describe("sendTo", () => {
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

  test("sendTo delivers to specific connection", async () => {
    await server.listen(0)

    clientA = new RealtimeClient(`ws://localhost:${server.port}`)
    clientB = new RealtimeClient(`ws://localhost:${server.port}`)
    await clientA.connect()
    await clientB.connect()

    const messagesA = []
    const messagesB = []
    clientA.on("message", (data) => { if (data.command === "dm") messagesA.push(data.payload) })
    clientB.on("message", (data) => { if (data.command === "dm") messagesB.push(data.payload) })

    await server.sendTo(clientA.connectionId, "dm", { text: "just for you" })
    await wait(300)

    expect(messagesA.length).toBe(1)
    expect(messagesA[0].text).toBe("just for you")
    expect(messagesB.length).toBe(0)
  })
})

describe("sendToWhere", () => {
  let server
  let clients = []

  beforeEach(async () => {
    await ctx.flush()
    server = createTestServer()
  })

  afterEach(async () => {
    for (const c of clients) await c.close()
    clients = []
    if (server) await server.close()
  })

  test("sends to all connections matching metadata predicate", async () => {
    server.onConnection(async (connection) => {
      await server.setConnectionMetadata(connection.id, { userId: connection.id.slice(0, 8) })
    })
    await server.listen(0)

    const makeClient = async () => {
      const c = new RealtimeClient(`ws://localhost:${server.port}`)
      await c.connect()
      clients.push(c)
      return c
    }

    const clientA = await makeClient()
    const clientB = await makeClient()
    const clientC = await makeClient()
    await wait(100)

    await server.setConnectionMetadata(clientA.connectionId, { userId: "user_1" })
    await server.setConnectionMetadata(clientB.connectionId, { userId: "user_1" })
    await server.setConnectionMetadata(clientC.connectionId, { userId: "user_2" })

    const messagesA = []
    const messagesB = []
    const messagesC = []
    clientA.on("message", (data) => { if (data.command === "notify") messagesA.push(data.payload) })
    clientB.on("message", (data) => { if (data.command === "notify") messagesB.push(data.payload) })
    clientC.on("message", (data) => { if (data.command === "notify") messagesC.push(data.payload) })

    await server.sendToWhere((meta) => meta.userId === "user_1", "notify", { job: "done" })
    await wait(300)

    expect(messagesA.length).toBe(1)
    expect(messagesA[0].job).toBe("done")
    expect(messagesB.length).toBe(1)
    expect(messagesB[0].job).toBe("done")
    expect(messagesC.length).toBe(0)
  })

  test("sends to no one when no metadata matches", async () => {
    await server.listen(0)

    const client = new RealtimeClient(`ws://localhost:${server.port}`)
    await client.connect()
    clients.push(client)
    await wait(100)

    await server.setConnectionMetadata(client.connectionId, { userId: "user_1" })

    const messages = []
    client.on("message", (data) => { if (data.command === "notify") messages.push(data.payload) })

    await server.sendToWhere((meta) => meta.userId === "nobody", "notify", { job: "done" })
    await wait(300)

    expect(messages.length).toBe(0)
  })

  test("handles connections with no metadata", async () => {
    await server.listen(0)

    const clientA = new RealtimeClient(`ws://localhost:${server.port}`)
    const clientB = new RealtimeClient(`ws://localhost:${server.port}`)
    await clientA.connect()
    await clientB.connect()
    clients.push(clientA, clientB)
    await wait(100)

    await server.setConnectionMetadata(clientA.connectionId, { userId: "user_1" })

    const messagesA = []
    const messagesB = []
    clientA.on("message", (data) => { if (data.command === "notify") messagesA.push(data.payload) })
    clientB.on("message", (data) => { if (data.command === "notify") messagesB.push(data.payload) })

    await server.sendToWhere((meta) => meta?.userId === "user_1", "notify", { job: "done" })
    await wait(300)

    expect(messagesA.length).toBe(1)
    expect(messagesB.length).toBe(0)
  })
})

describe("getConnectionsWhere", () => {
  let server
  let clients = []

  beforeEach(async () => {
    await ctx.flush()
    server = createTestServer()
  })

  afterEach(async () => {
    for (const c of clients) await c.close()
    clients = []
    if (server) await server.close()
  })

  test("returns connections matching metadata predicate", async () => {
    await server.listen(0)

    const makeClient = async () => {
      const c = new RealtimeClient(`ws://localhost:${server.port}`)
      await c.connect()
      clients.push(c)
      return c
    }

    const clientA = await makeClient()
    const clientB = await makeClient()
    const clientC = await makeClient()
    await wait(100)

    await server.setConnectionMetadata(clientA.connectionId, { role: "admin" })
    await server.setConnectionMetadata(clientB.connectionId, { role: "admin" })
    await server.setConnectionMetadata(clientC.connectionId, { role: "viewer" })

    const admins = await server.getConnectionsWhere((meta) => meta?.role === "admin")
    expect(admins.length).toBe(2)
    const adminIds = admins.map(({ id }) => id).sort()
    expect(adminIds).toEqual([clientA.connectionId, clientB.connectionId].sort())
  })

  test("returns empty array when nothing matches", async () => {
    await server.listen(0)

    const client = new RealtimeClient(`ws://localhost:${server.port}`)
    await client.connect()
    clients.push(client)
    await wait(100)

    await server.setConnectionMetadata(client.connectionId, { role: "viewer" })

    const result = await server.getConnectionsWhere((meta) => meta?.role === "admin")
    expect(result.length).toBe(0)
  })
})

describe("disconnectWhere", () => {
  let server
  let clients = []

  beforeEach(async () => {
    await ctx.flush()
    server = createTestServer()
  })

  afterEach(async () => {
    for (const c of clients) await c.close()
    clients = []
    if (server) await server.close()
  })

  test("disconnects all connections matching metadata predicate", async () => {
    await server.listen(0)

    const makeClient = async () => {
      const c = new RealtimeClient(`ws://localhost:${server.port}`, { shouldReconnect: false })
      await c.connect()
      clients.push(c)
      return c
    }

    const clientA = await makeClient()
    const clientB = await makeClient()
    const clientC = await makeClient()
    await wait(100)

    await server.setConnectionMetadata(clientA.connectionId, { userId: "banned_user" })
    await server.setConnectionMetadata(clientB.connectionId, { userId: "banned_user" })
    await server.setConnectionMetadata(clientC.connectionId, { userId: "good_user" })

    const disconnectedA = new Promise((resolve) => clientA.on("close", resolve))
    const disconnectedB = new Promise((resolve) => clientB.on("close", resolve))

    await server.disconnectWhere((meta) => meta?.userId === "banned_user")
    await Promise.all([disconnectedA, disconnectedB])

    expect(clientC.status).toBe(3) // still online
  })

  test("does nothing when no metadata matches", async () => {
    await server.listen(0)

    const client = new RealtimeClient(`ws://localhost:${server.port}`)
    await client.connect()
    clients.push(client)
    await wait(100)

    await server.setConnectionMetadata(client.connectionId, { userId: "safe_user" })

    await server.disconnectWhere((meta) => meta?.userId === "nobody")
    await wait(300)

    expect(client.status).toBe(3) // still online
  })
})

describe("attach", () => {
  let server
  let client
  let httpServer

  afterEach(async () => {
    if (client) await client.close()
    if (server) await server.close()
  })

  test("attach to existing http server and close preserves it", async () => {
    const http = await import("node:http")
    httpServer = http.createServer()

    server = createTestServer()
    server.exposeCommand("ping-test", () => "pong")

    await server.attach(httpServer, { port: 0 })

    const port = httpServer.address().port
    client = new RealtimeClient(`ws://localhost:${port}`)
    await client.connect()

    const result = await client.command("ping-test", {})
    expect(result).toBe("pong")

    await client.close()
    client = null
    await server.close()
    server = null

    // http server should still be listening after server.close()
    expect(httpServer.listening).toBe(true)
    httpServer.close()
  })
})
