// @vitest-environment happy-dom
import { describe, it, expect } from "vitest"
import { defineComponent, h } from "vue"
import { mount, flushPromises } from "@vue/test-utils"
import { useCollection } from "../../src/vue/index.js"

// fake client that captures the onDiff useCollection registers, so the test can
// drive server diffs directly without redis
function fakeClient(snapshot) {
  let captured = null
  return {
    async subscribeCollection(id, opts) {
      captured = opts.onDiff
      return { success: true, ids: snapshot.map((e) => e.id), records: snapshot, version: 1 }
    },
    async unsubscribeCollection() { return true },
    diff(payload) { return captured?.(payload) },
  }
}

function mountCollection(client, id = "c") {
  let api
  const Comp = defineComponent({
    setup() { api = useCollection(id, { client }); return () => h("div") },
  })
  mount(Comp)
  return () => api
}

describe("useCollection diff application", () => {
  it("applies add then remove to items", async () => {
    const client = fakeClient([])
    const api = mountCollection(client)
    await flushPromises()
    expect(api().items.value).toEqual([])

    await client.diff({ added: [{ id: "a", record: { id: "a", n: 1 } }], removed: [], changed: [], version: 2 })
    expect(api().items.value).toEqual([{ id: "a", n: 1 }])

    await client.diff({ added: [], removed: [{ id: "a", record: { id: "a" } }], changed: [], version: 3 })
    expect(api().items.value).toEqual([])
  })

  it("a reset snapshot replaces items so a removal lost across a desync converges", async () => {
    const client = fakeClient([
      { id: "a", record: { id: "a" } },
      { id: "b", record: { id: "b" } },
    ])
    const api = mountCollection(client)
    await flushPromises()
    expect(api().items.value.map((x) => x.id)).toEqual(["a", "b"])

    // server re-resolved after "a" was deleted and redelivered the snapshot via a
    // resubscribe (reset). without replace-on-reset, "a" would be stranded here.
    await client.diff({ added: [{ id: "b", record: { id: "b" } }], removed: [], changed: [], version: 1, reset: true })
    expect(api().items.value.map((x) => x.id)).toEqual(["b"])
  })
})
