import { describe, test, expect, beforeEach, afterEach } from "vitest"
import { RealtimeServer } from "../../src/index.js"
import { RealtimeClient } from "../../src/client/index.js"
import { createTestContext, wait } from "../helpers.js"

const ctx = createTestContext()

const createTestServer = (opts = {}) =>
  new RealtimeServer({ redis: ctx.redisOptions, ...opts })

describe("channels", () => {
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

  test("subscribe and receive channel messages", async () => {
    server.exposeChannel("chat:lobby")
    await server.listen(0)

    clientA = new RealtimeClient(`ws://localhost:${server.port}`)
    clientB = new RealtimeClient(`ws://localhost:${server.port}`)
    await clientA.connect()
    await clientB.connect()

    const received = []
    await clientA.subscribeChannel("chat:lobby", (message) => {
      received.push(message)
    })

    await server.writeChannel("chat:lobby", "hello world")
    await wait(300)

    expect(received).toContain("hello world")
  })

  test("unexposed channel returns failure", async () => {
    await server.listen(0)

    clientA = new RealtimeClient(`ws://localhost:${server.port}`)
    await clientA.connect()

    const result = await clientA.subscribeChannel("secret:channel", () => {})
    expect(result.success).toBe(false)
  })

  test("channel with regex pattern", async () => {
    server.exposeChannel(/^chat:/)
    await server.listen(0)

    clientA = new RealtimeClient(`ws://localhost:${server.port}`)
    await clientA.connect()

    const received = []
    await clientA.subscribeChannel("chat:room1", (message) => {
      received.push(message)
    })

    await server.writeChannel("chat:room1", "test message")
    await wait(300)

    expect(received).toContain("test message")
  })

  test("writeChannel auto-stringifies objects", async () => {
    server.exposeChannel("data")
    await server.listen(0)

    clientA = new RealtimeClient(`ws://localhost:${server.port}`)
    await clientA.connect()

    const received = []
    await clientA.subscribeChannel("data", (message) => {
      received.push(message)
    })

    await server.writeChannel("data", { type: "event", value: 42 })
    await wait(300)

    expect(received.length).toBe(1)
    const parsed = JSON.parse(received[0])
    expect(parsed.type).toBe("event")
    expect(parsed.value).toBe(42)
  })

  test("writeChannel passes strings through unchanged", async () => {
    server.exposeChannel("raw")
    await server.listen(0)

    clientA = new RealtimeClient(`ws://localhost:${server.port}`)
    await clientA.connect()

    const received = []
    await clientA.subscribeChannel("raw", (message) => {
      received.push(message)
    })

    await server.writeChannel("raw", "plain text")
    await wait(300)

    expect(received[0]).toBe("plain text")
  })

  test("channel guard blocks unauthorized access", async () => {
    server.exposeChannel("private:vip", () => false)
    await server.listen(0)

    clientA = new RealtimeClient(`ws://localhost:${server.port}`)
    await clientA.connect()

    const result = await clientA.subscribeChannel("private:vip", () => {})
    expect(result.success).toBe(false)
  })
})
