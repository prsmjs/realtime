import { describe, test, expect, beforeEach, afterEach } from "vitest"
import { RealtimeServer } from "../../src/index.js"
import { RealtimeClient } from "../../src/client/index.js"
import { createTestContext, wait } from "../helpers.js"

const ctx = createTestContext()

const createTestServer = (opts = {}) =>
  new RealtimeServer({ redis: ctx.redisOptions, ...opts })

describe("middleware", () => {
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

  test("global middleware runs on all commands", async () => {
    const log = []
    server.useMiddleware((ctx) => {
      log.push(ctx.command)
    })

    server.exposeCommand("a", () => "a")
    server.exposeCommand("b", () => "b")
    await server.listen(0)

    client = new RealtimeClient(`ws://localhost:${server.port}`)
    await client.connect()

    await client.command("a", {})
    await client.command("b", {})

    expect(log).toContain("a")
    expect(log).toContain("b")
  })

  test("per-command middleware only runs on that command", async () => {
    const log = []

    server.exposeCommand("guarded", () => "ok", [
      (ctx) => { log.push("guarded-mw") },
    ])
    server.exposeCommand("open", () => "ok")

    await server.listen(0)

    client = new RealtimeClient(`ws://localhost:${server.port}`)
    await client.connect()

    await client.command("open", {})
    await client.command("guarded", {})

    expect(log).toEqual(["guarded-mw"])
  })

  test("middleware can reject by throwing", async () => {
    server.exposeCommand("protected", () => "secret", [
      () => { throw new Error("access denied") },
    ])

    await server.listen(0)

    client = new RealtimeClient(`ws://localhost:${server.port}`)
    await client.connect()

    const result = await client.command("protected", {})
    expect(result.error).toBe("access denied")
  })

  test("global middleware runs before per-command middleware", async () => {
    const order = []
    server.useMiddleware(() => { order.push("global") })

    server.exposeCommand("ordered", () => "ok", [
      () => { order.push("per-command") },
    ])

    await server.listen(0)

    client = new RealtimeClient(`ws://localhost:${server.port}`)
    await client.connect()

    await client.command("ordered", {})

    expect(order).toEqual(["global", "per-command"])
  })
})
