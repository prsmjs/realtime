import { describe, test, expect, beforeEach, afterEach } from "vitest"
import { RealtimeServer } from "../../src/index.js"
import { RealtimeClient } from "../../src/client/index.js"
import { createTestContext, wait } from "../helpers.js"

const ctx = createTestContext()

const createTestServer = (opts = {}) =>
  new RealtimeServer({ redis: ctx.redisOptions, ...opts })

describe("record guards", () => {
  let server
  let clientA
  let clientB

  beforeEach(async () => {
    await ctx.flush()
  })

  afterEach(async () => {
    if (clientA) await clientA.close()
    if (clientB) await clientB.close()
    if (server) await server.close()
  })

  test("read guard allows access", async () => {
    server = createTestServer({
      authenticateConnection: () => ({ role: "admin" }),
    })

    server.exposeRecord(/^secret:/, async (connection, recordId) => {
      const meta = await server.connectionManager.getMetadata(connection)
      return meta?.role === "admin"
    })

    await server.listen(0)
    await server.writeRecord("secret:data", { value: 42 })

    clientA = new RealtimeClient(`ws://localhost:${server.port}`)
    await clientA.connect()

    const result = await clientA.subscribeRecord("secret:data", () => {})
    expect(result.success).toBe(true)
    expect(result.record.value).toBe(42)
  })

  test("read guard blocks access", async () => {
    server = createTestServer({
      authenticateConnection: () => ({ role: "guest" }),
    })

    server.exposeRecord(/^secret:/, async (connection) => {
      const meta = await server.connectionManager.getMetadata(connection)
      return meta?.role === "admin"
    })

    await server.listen(0)
    await server.writeRecord("secret:data", { value: 42 })

    clientA = new RealtimeClient(`ws://localhost:${server.port}`)
    await clientA.connect()

    const result = await clientA.subscribeRecord("secret:data", () => {})
    expect(result.success).toBe(false)
  })

  test("write guard blocks unauthorized writes", async () => {
    server = createTestServer({
      authenticateConnection: () => ({ role: "viewer" }),
    })

    server.exposeRecord(/^doc:/)
    server.exposeWritableRecord(/^doc:/, async (connection) => {
      const meta = await server.connectionManager.getMetadata(connection)
      return meta?.role === "editor"
    })

    await server.listen(0)

    clientA = new RealtimeClient(`ws://localhost:${server.port}`)
    await clientA.connect()

    await clientA.subscribeRecord("doc:1", () => {})
    const result = await clientA.command("mesh/publish-record-update", {
      recordId: "doc:1",
      newValue: { hacked: true },
    })

    expect(result.error).toBeDefined()
  })

  test("write guard allows authorized writes", async () => {
    server = createTestServer({
      authenticateConnection: () => ({ role: "editor" }),
    })

    server.exposeWritableRecord(/^doc:/, async (connection) => {
      const meta = await server.connectionManager.getMetadata(connection)
      return meta?.role === "editor"
    })

    await server.listen(0)

    clientA = new RealtimeClient(`ws://localhost:${server.port}`)
    await clientA.connect()

    await clientA.subscribeRecord("doc:1", () => {})
    const result = await clientA.command("mesh/publish-record-update", {
      recordId: "doc:1",
      newValue: { content: "legit" },
    })

    expect(result.success).toBe(true)
  })
})

describe("presence guards", () => {
  let server
  let clientA

  beforeEach(async () => {
    await ctx.flush()
  })

  afterEach(async () => {
    if (clientA) await clientA.close()
    if (server) await server.close()
  })

  test("presence guard blocks untracked rooms", async () => {
    server = createTestServer()
    server.trackPresence("vip-room", () => false)
    await server.listen(0)

    clientA = new RealtimeClient(`ws://localhost:${server.port}`)
    await clientA.connect()

    const result = await clientA.command("mesh/subscribe-presence", { roomName: "vip-room" })
    expect(result.success).toBe(false)
  })
})
