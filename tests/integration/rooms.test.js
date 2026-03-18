import { describe, test, expect, beforeEach, afterEach } from "vitest"
import { RealtimeServer } from "../../src/index.js"
import { RealtimeClient } from "../../src/client/index.js"
import { createTestContext, wait } from "../helpers.js"

const ctx = createTestContext()

const createTestServer = (opts = {}) =>
  new RealtimeServer({ redis: ctx.redisOptions, ...opts })

describe("rooms", () => {
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

  test("join room via command", async () => {
    await server.listen(0)

    clientA = new RealtimeClient(`ws://localhost:${server.port}`)
    await clientA.connect()

    const result = await clientA.joinRoom("lobby")
    expect(result.success).toBe(true)

    const members = await server.getRoomMembers("lobby")
    expect(members).toContain(clientA.connectionId)
  })

  test("leave room via command", async () => {
    await server.listen(0)

    clientA = new RealtimeClient(`ws://localhost:${server.port}`)
    await clientA.connect()

    await clientA.joinRoom("lobby")
    await clientA.command("mesh/leave-room", { roomName: "lobby" })

    const members = await server.getRoomMembers("lobby")
    expect(members).not.toContain(clientA.connectionId)
  })

  test("broadcastRoom sends to room members only", async () => {
    server.exposeCommand("setup", async (ctx) => {
      await ctx.server.addToRoom("vip", ctx.connection)
      return true
    })

    await server.listen(0)

    clientA = new RealtimeClient(`ws://localhost:${server.port}`)
    clientB = new RealtimeClient(`ws://localhost:${server.port}`)
    await clientA.connect()
    await clientB.connect()

    await clientA.command("setup", {})

    const messagesA = []
    const messagesB = []
    clientA.on("message", (data) => { if (data.command === "notify") messagesA.push(data.payload) })
    clientB.on("message", (data) => { if (data.command === "notify") messagesB.push(data.payload) })

    await server.broadcastRoom("vip", "notify", { text: "vip only" })
    await wait(300)

    expect(messagesA.length).toBe(1)
    expect(messagesB.length).toBe(0)
  })

  test("server-side room operations", async () => {
    await server.listen(0)

    clientA = new RealtimeClient(`ws://localhost:${server.port}`)
    await clientA.connect()
    await wait(100)

    const connId = clientA.connectionId
    await server.addToRoom("test-room", connId)

    expect(await server.isInRoom("test-room", connId)).toBe(true)

    const members = await server.getRoomMembers("test-room")
    expect(members).toContain(connId)

    const rooms = await server.getAllRooms()
    expect(rooms).toContain("test-room")

    await server.removeFromRoom("test-room", connId)
    expect(await server.isInRoom("test-room", connId)).toBe(false)
  })

  test("room metadata", async () => {
    await server.listen(0)

    await server.roomManager.setMetadata("game-room", { maxPlayers: 4 })
    const meta = await server.roomManager.getMetadata("game-room")
    expect(meta.maxPlayers).toBe(4)

    await server.roomManager.setMetadata("game-room", { currentMap: "forest" }, { strategy: "merge" })
    const merged = await server.roomManager.getMetadata("game-room")
    expect(merged.maxPlayers).toBe(4)
    expect(merged.currentMap).toBe("forest")
  })
})
