import { describe, test, expect, beforeEach, afterEach } from "vitest"
import { RealtimeServer } from "../../src/index.js"
import { RealtimeClient } from "../../src/client/index.js"
import { createTestContext, wait } from "../helpers.js"

const ctx = createTestContext()

const createTestServer = (opts = {}) =>
  new RealtimeServer({ redis: ctx.redisOptions, ...opts })

describe("distributed subscriptions across instances", () => {
  let server1
  let server2
  let clientA
  let clientB

  beforeEach(async () => {
    await ctx.flush()
    server1 = createTestServer()
    server2 = createTestServer()
    server1.exposeChannel(/^chat:.+$/)
    server2.exposeChannel(/^chat:.+$/)
    server1.exposeRecord(/^doc:.+$/)
    server2.exposeRecord(/^doc:.+$/)
    server1.exposeCollection(/^inbox$/, () => [{ id: "msg:1" }])
    server2.exposeCollection(/^inbox$/, () => [{ id: "msg:1" }])
    await server1.listen(0)
    await server2.listen(0)
  })

  afterEach(async () => {
    if (clientA) await clientA.close()
    if (clientB) await clientB.close()
    if (server1) await server1.close()
    if (server2) await server2.close()
  })

  test("channel subscribers from one instance are visible on the other", async () => {
    clientA = new RealtimeClient(`ws://localhost:${server1.port}`)
    await clientA.connect()
    await clientA.subscribeChannel("chat:room-1", () => {})

    await wait(50)

    const fromServer2 = await server2.channelManager.getAllSubscriberIds("chat:room-1")
    expect(fromServer2).toContain(clientA.connectionId)
  })

  test("record subscribers from one instance are visible on the other", async () => {
    clientA = new RealtimeClient(`ws://localhost:${server1.port}`)
    await clientA.connect()
    await clientA.subscribeRecord("doc:42", () => {})

    await wait(50)

    const fromServer2 = await server2.recordSubscriptionManager.getAllSubscribers("doc:42")
    expect(fromServer2).toHaveProperty(clientA.connectionId)
  })

  test("collection subscribers from one instance are visible on the other", async () => {
    clientA = new RealtimeClient(`ws://localhost:${server1.port}`)
    await clientA.connect()
    await clientA.subscribeCollection("inbox", { onDiff: () => {} })

    await wait(50)

    const fromServer2 = await server2.collectionManager.getAllSubscribers("inbox")
    expect(fromServer2).toHaveProperty(clientA.connectionId)
  })

  test("disconnect cleans up subscriptions across instances", async () => {
    clientA = new RealtimeClient(`ws://localhost:${server1.port}`)
    await clientA.connect()
    const connId = clientA.connectionId

    await clientA.subscribeChannel("chat:room-1", () => {})
    await clientA.subscribeRecord("doc:42", () => {})

    await wait(50)

    // visible on other instance
    expect(await server2.channelManager.getAllSubscriberIds("chat:room-1")).toContain(connId)
    expect(await server2.recordSubscriptionManager.getAllSubscribers("doc:42")).toHaveProperty(connId)

    await clientA.close()
    clientA = null

    await wait(300)

    // gone from both
    expect(await server1.channelManager.getAllSubscriberIds("chat:room-1")).not.toContain(connId)
    expect(await server2.channelManager.getAllSubscriberIds("chat:room-1")).not.toContain(connId)
    expect(await server1.recordSubscriptionManager.getAllSubscribers("doc:42")).not.toHaveProperty(connId)
    expect(await server2.recordSubscriptionManager.getAllSubscribers("doc:42")).not.toHaveProperty(connId)
  })

  test("listAllChannels aggregates across instances", async () => {
    clientA = new RealtimeClient(`ws://localhost:${server1.port}`)
    clientB = new RealtimeClient(`ws://localhost:${server2.port}`)
    await clientA.connect()
    await clientB.connect()
    await clientA.subscribeChannel("chat:room-1", () => {})
    await clientB.subscribeChannel("chat:room-2", () => {})

    await wait(50)

    const channelsFromServer1 = await server1.channelManager.listAllChannels()
    expect(channelsFromServer1).toContain("chat:room-1")
    expect(channelsFromServer1).toContain("chat:room-2")
  })
})
