// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { WebSocket as NodeWebSocket } from "ws"
import { defineComponent, h } from "vue"
import { mount } from "@vue/test-utils"
import { RealtimeServer } from "../../src/index.js"
import { RealtimeClient } from "../../src/client/index.js"
import { provideRealtime, useCollection } from "../../src/vue/index.js"
import { createTestContext, wait } from "../helpers.js"

let ctx, server, client

beforeEach(async () => {
  globalThis.WebSocket = NodeWebSocket
  ctx = createTestContext()
  await ctx.flush()
})

afterEach(async () => {
  try { client?.close() } catch {}
  try { await server?.close() } catch {}
  await ctx.cleanup()
  client = null
  server = null
})

const byCreatedAtDesc = (a, b) => (a.createdAt < b.createdAt ? 1 : -1)

describe("useCollection end-to-end add+delete on a live connection", () => {
  it("removes a live-added record from items when deleted (no refresh)", async () => {
    const J = "jurisdiction:a6014815-8893-4a8d-ae2b-28e86d471917"
    server = new RealtimeServer({
      redis: ctx.redisOptions,
      authenticateConnection: async () => ({ accountId: "acc1" }),
    })
    server.exposeRecord(/^jurisdiction:/)
    server.exposeCollection(/^jurisdiction:.*:documents$/, async (connection) => {
      const meta = await server.getConnectionMetadata(connection.id)
      if (!meta?.accountId) return []
      return server.listRecordsMatching(`${J}:doc:*`, { sort: byCreatedAtDesc })
    })
    await server.listen(0)

    // pre-existing ingested docs (values carry no `id` field, like leegul)
    await server.writeRecord(`${J}:doc:d1`, { docId: "d1", filename: "one.pdf", status: "stored", createdAt: "2026-01-01T00:00:00.000Z" })
    await server.writeRecord(`${J}:doc:d2`, { docId: "d2", filename: "two.pdf", status: "stored", createdAt: "2026-01-02T00:00:00.000Z" })

    client = new RealtimeClient(`ws://localhost:${server.port}`)
    await client.connect()

    let api
    const Comp = defineComponent({
      setup() { api = useCollection(`${J}:documents`, {}); return () => h("div") },
    })
    mount(defineComponent({ setup() { provideRealtime(client); return () => h(Comp) } }))

    await wait(300)
    expect(api.items.value.map((x) => x.docId).sort()).toEqual(["d1", "d2"])

    // live upload of a new doc (newest createdAt)
    await server.writeRecord(`${J}:doc:x`, { docId: "x", filename: "x.pdf", status: "stored", createdAt: "2026-06-24T16:17:07.948Z" })
    await wait(400)
    expect(api.items.value.some((x) => x.docId === "x")).toBe(true)

    // delete it - same connection, no refresh
    await server.deleteRecord(`${J}:doc:x`)
    await wait(400)

    expect(api.items.value.some((x) => x.docId === "x")).toBe(false)
    expect(api.items.value.map((x) => x.docId).sort()).toEqual(["d1", "d2"])
  })
})
