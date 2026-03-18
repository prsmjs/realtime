import { describe, test, expect, beforeEach, afterEach } from "vitest"
import { RealtimeServer } from "../../src/index.js"
import { RealtimeClient } from "../../src/client/index.js"
import { createTestContext, wait } from "../helpers.js"

const ctx = createTestContext()

const createTestServer = (opts = {}) =>
  new RealtimeServer({ redis: ctx.redisOptions, ...opts })

describe("multi-instance", () => {
  let server1
  let server2
  let clientA
  let clientB

  beforeEach(async () => {
    await ctx.flush()
    server1 = createTestServer()
    server2 = createTestServer()
  })

  afterEach(async () => {
    if (clientA) await clientA.close()
    if (clientB) await clientB.close()
    if (server1) await server1.close()
    if (server2) await server2.close()
  })

  test("broadcast across instances", async () => {
    server1.exposeCommand("join-and-listen", async (ctx) => {
      await ctx.server.addToRoom("global", ctx.connection)
      return true
    })

    server2.exposeCommand("join-and-listen", async (ctx) => {
      await ctx.server.addToRoom("global", ctx.connection)
      return true
    })

    await server1.listen(0)
    await server2.listen(0)

    clientA = new RealtimeClient(`ws://localhost:${server1.port}`)
    clientB = new RealtimeClient(`ws://localhost:${server2.port}`)
    await clientA.connect()
    await clientB.connect()

    await clientA.command("join-and-listen", {})
    await clientB.command("join-and-listen", {})

    const received = []
    clientB.on("message", (data) => {
      if (data.command === "cross-instance") received.push(data.payload)
    })

    await server1.broadcastRoom("global", "cross-instance", { msg: "hello from server1" })
    await wait(500)

    expect(received.length).toBe(1)
    expect(received[0].msg).toBe("hello from server1")
  })

  test("record updates propagate across instances", async () => {
    server1.exposeRecord(/^shared:/)
    server2.exposeRecord(/^shared:/)

    await server1.listen(0)
    await server2.listen(0)

    clientA = new RealtimeClient(`ws://localhost:${server1.port}`)
    clientB = new RealtimeClient(`ws://localhost:${server2.port}`)
    await clientA.connect()
    await clientB.connect()

    const updates = []
    // skip initial callback
    let skipFirst = true
    await clientB.subscribeRecord("shared:doc", (update) => {
      if (skipFirst) { skipFirst = false; return }
      updates.push(update)
    })

    await server1.writeRecord("shared:doc", { content: "from server 1" })
    await wait(500)

    expect(updates.length).toBeGreaterThanOrEqual(1)
    expect(updates[0].full.content).toBe("from server 1")
  })
})
