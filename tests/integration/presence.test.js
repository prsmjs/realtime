import { describe, test, expect, beforeEach, afterEach } from "vitest"
import { RealtimeServer } from "../../src/index.js"
import { RealtimeClient } from "../../src/client/index.js"
import { createTestContext, wait } from "../helpers.js"

const ctx = createTestContext()

const createTestServer = (opts = {}) =>
  new RealtimeServer({ redis: ctx.redisOptions, ...opts })

describe("presence", () => {
  let server
  let clientA
  let clientB

  beforeEach(async () => {
    await ctx.flush()
    server = createTestServer()
    server.trackPresence(/.*/)
  })

  afterEach(async () => {
    if (clientA) await clientA.close()
    if (clientB) await clientB.close()
    if (server) await server.close()
  })

  test("subscribe to presence and see join/leave", async () => {
    await server.listen(0)

    clientA = new RealtimeClient(`ws://localhost:${server.port}`)
    clientB = new RealtimeClient(`ws://localhost:${server.port}`, { shouldReconnect: false })
    await clientA.connect()
    await clientB.connect()

    await clientA.joinRoom("room1")
    await clientB.joinRoom("room1")

    const updates = []
    await clientA.subscribePresence("room1", (update) => {
      updates.push(update)
    })

    await wait(100)

    const connBId = clientB.connectionId
    await clientB.close()
    clientB = null
    await wait(1000)

    const leaveUpdate = updates.find(
      (u) => u.type === "leave" && u.connectionId === connBId
    )
    expect(leaveUpdate).toBeTruthy()
  })

  test("publish and receive presence state", async () => {
    await server.listen(0)

    clientA = new RealtimeClient(`ws://localhost:${server.port}`)
    clientB = new RealtimeClient(`ws://localhost:${server.port}`)
    await clientA.connect()
    await clientB.connect()

    await clientA.joinRoom("collab")
    await clientB.joinRoom("collab")

    const states = []
    await clientA.subscribePresence("collab", (update) => {
      if (update.type === "state") states.push(update)
    })

    await wait(100)

    await clientB.command("mesh/publish-presence-state", {
      roomName: "collab",
      state: { cursor: { x: 100, y: 200 } },
    })

    await wait(300)

    expect(states.length).toBeGreaterThanOrEqual(1)
    expect(states[0].state.cursor.x).toBe(100)
  })
})
