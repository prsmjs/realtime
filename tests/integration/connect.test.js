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

    // http server should still be listening after mesh.close()
    expect(httpServer.listening).toBe(true)
    httpServer.close()
  })
})
