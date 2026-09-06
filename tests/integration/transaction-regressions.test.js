import { afterAll, afterEach, beforeEach, describe, expect, test } from "vitest"
import { RealtimeServer } from "../../src/index.js"
import { RealtimeClient } from "../../src/client/index.js"
import { createTestContext } from "../helpers.js"

const ctx = createTestContext()
const id = (name) => `tx-regression:${name}`
const deferred = () => {
  let resolve
  const promise = new Promise((done) => { resolve = done })
  return { promise, resolve }
}

// hold the competing redis response until the lock holder commits
async function contend(holderServer, contenderServer, holderOptions, compete) {
  const entered = deferred()
  const release = deferred()
  const events = []
  const holder = holderServer.transaction(async (tx) => {
    const before = await tx.getRecord(id("counter"))
    entered.resolve()
    await release.promise
    tx.writeRecord(id("counter"), { count: before.count + 1 })
    events.push("holder")
  }, holderOptions)
  // attach before cleanup can reject
  holder.catch(() => {})
  await entered.promise

  const redis = contenderServer.recordManager.getRedis()
  const original = redis.sendCommand
  const contacted = deferred()
  let first = true
  redis.sendCommand = function (command, ...args) {
    if (first) {
      first = false
      // pipelines await command.promise rather than sendCommand's return value
      const resolve = command.resolve
      const reject = command.reject
      command.resolve = (value) => {
        contacted.resolve()
        holder.then(() => resolve.call(command, value), (error) => reject.call(command, error))
      }
      command.reject = (error) => {
        contacted.resolve()
        reject.call(command, error)
      }
    }
    return original.call(this, command, ...args)
  }
  let competitor
  try {
    competitor = compete(events)
    competitor.catch(() => {})
    await contacted.promise
    release.resolve()
    await holder
    await competitor
    return events
  } finally {
    release.resolve()
    redis.sendCommand = original
    await Promise.allSettled([holder, competitor].filter(Boolean))
  }
}

describe("transaction regressions", () => {
  let server
  let peer
  let client

  beforeEach(async () => {
    await ctx.flush()
    server = new RealtimeServer({ redis: ctx.redisOptions })
    server.exposeRecord(/^tx-regression:/)
    server.exposeWritableRecord(/^tx-regression:/)
    await server.listen(0)
  })

  afterEach(async () => {
    if (client) await client.close()
    if (peer) await peer.close()
    if (server) await server.close()
    client = peer = server = undefined
  })

  afterAll(async () => { await ctx.cleanup() })

  async function connectClient() {
    client = new RealtimeClient(`ws://localhost:${server.port}`)
    await client.connect()
    return client
  }

  async function startPeer() {
    peer = new RealtimeServer({ redis: ctx.redisOptions })
    await peer.listen(0)
  }

  async function snapshot(names) {
    return Promise.all(names.map((name) => server.recordManager.getRecordAndVersion(id(name))))
  }

  test("a numeric options value in a later batch operation leaves values and versions untouched", async () => {
    await connectClient()
    await server.writeRecord(id("first"), { original: 1 })
    await server.writeRecord(id("deleted"), { original: 2 })
    const names = ["first", "deleted", "later"]
    const before = await snapshot(names)
    await expect(client.transaction([
      { op: "write", recordId: id("first"), value: { changed: true } },
      { op: "delete", recordId: id("deleted") },
      { op: "write", recordId: id("later"), value: { changed: true }, options: 7 },
    ])).rejects.toThrow()
    expect(await snapshot(names)).toEqual(before)
  })

  test("batch JSON round trips preserve empty arrays and large safe integers", async () => {
    await connectClient()
    const value = {
      empty: [], nested: { empty: [], values: [[], { empty: [] }] },
      positive: Number.MAX_SAFE_INTEGER, negative: Number.MIN_SAFE_INTEGER,
      precise: 1234567890123456,
    }
    await client.transaction([{ op: "write", recordId: id("json"), value }])
    expect(await server.getRecord(id("json"))).toEqual(value)
  })

  test("unchanged writes and missing deletes succeed without changing versions", async () => {
    await connectClient()
    await server.writeRecord(id("same"), { count: 1 })
    const before = await snapshot(["same", "missing"])
    const batch = await client.transaction([
      { op: "write", recordId: id("same"), value: { count: 1 } },
      { op: "delete", recordId: id("missing") },
    ])
    expect(batch.results).toHaveLength(2)
    expect(batch.results.every((entry) => entry.success === true)).toBe(true)
    expect(await snapshot(["same", "missing"])).toEqual(before)
    const tx = await server.transaction((staged) => {
      staged.writeRecord(id("same"), { count: 1 })
      staged.deleteRecord(id("missing"))
    })
    expect(tx.changes).toEqual([])
  })

  test("deepMerge replaces arrays and committed state equals read-your-writes", async () => {
    await server.writeRecord(id("merge"), {
      items: [{ old: true }, 2, 3], nested: { keep: true, items: [1, 2] },
    })
    const expected = { items: [{ fresh: true }], nested: { keep: true, items: [] } }
    const { result } = await server.transaction(async (tx) => {
      tx.writeRecord(id("merge"), { items: [{ fresh: true }], nested: { items: [] } }, { strategy: "deepMerge" })
      return tx.getRecord(id("merge"))
    }, { records: [id("merge")] })
    expect(result).toEqual(expected)
    expect(await server.getRecord(id("merge"))).toEqual(result)
  })

  test.each(["global", "records"])("a held %s transaction serializes with the other mode across servers", async (mode) => {
    await startPeer()
    await server.writeRecord(id("counter"), { count: 0 })
    const records = { records: [id("counter")] }
    const events = await contend(server, peer, mode === "global" ? undefined : records, (order) =>
      peer.transaction(async (tx) => {
        const current = await tx.getRecord(id("counter"))
        tx.writeRecord(id("counter"), { count: current.count + 1 })
        order.push("competitor")
      }, mode === "global" ? records : undefined))
    expect(events).toEqual(["holder", "competitor"])
    expect(await server.getRecord(id("counter"))).toEqual({ count: 2 })
    expect(await server.recordManager.getVersion(id("counter"))).toBe(3)
  })

  test.each(["global", "records"])("publishUpdate does not bypass a held %s transaction", async (mode) => {
    await startPeer()
    await server.writeRecord(id("counter"), { count: 0 })
    await contend(server, peer, mode === "global" ? undefined : { records: [id("counter")] }, () =>
      peer.recordManager.publishUpdate(id("counter"), { ordinary: true }, "merge"))
    expect(await server.getRecord(id("counter"))).toEqual({ count: 1, ordinary: true })
    expect(await server.recordManager.getVersion(id("counter"))).toBe(3)
  })

  test.each(["global", "records"])("deleteRecord does not bypass a held %s transaction", async (mode) => {
    await startPeer()
    await server.writeRecord(id("counter"), { count: 0 })
    let deletion
    await contend(server, peer, mode === "global" ? undefined : { records: [id("counter")] }, async () => {
      deletion = await peer.recordManager.deleteRecord(id("counter"))
    })
    // deletion must observe the lock holder's committed version
    expect(deletion.version).toBe(2)
    expect(await server.getRecord(id("counter"))).toBeNull()
  })

  test.each(["getRecord", "writeRecord", "deleteRecord"])("records mode rejects undeclared %s access and rolls back earlier staging", async (method) => {
    await server.writeRecord(id("declared"), { count: 0 })
    await server.writeRecord(id("undeclared"), { count: 0 })
    const before = await snapshot(["declared", "undeclared"])
    await expect(server.transaction(async (tx) => {
      tx.writeRecord(id("declared"), { count: 1 })
      await tx[method](id("undeclared"), { count: 2 })
    }, { records: [id("declared")] })).rejects.toThrow()
    expect(await snapshot(["declared", "undeclared"])).toEqual(before)
  })

  test.each(["global", "records"])("loss of %s lock ownership aborts without writes or waiting for TTL", async (mode) => {
    await server.writeRecord(id("first"), { count: 0 })
    await server.writeRecord(id("deleted"), { count: 0 })
    const before = await snapshot(["first", "deleted"])
    let removedLocks = 0
    await expect(server.transaction(async (tx) => {
      tx.writeRecord(id("first"), { count: 1 })
      tx.deleteRecord(id("deleted"))
      const redis = server.recordManager.getRedis()
      let cursor = "0"
      const locks = []
      do {
        const [next, keys] = await redis.scan(cursor, "MATCH", "rt:*", "COUNT", 100)
        cursor = next
        locks.push(...keys.filter((key) => key.includes("lock") && !key.includes("cleanup")))
      } while (cursor !== "0")
      if (locks.length) removedLocks = await redis.del(...locks)
    }, mode === "global" ? undefined : { records: [id("first"), id("deleted")] })).rejects.toThrow()
    expect(removedLocks).toBeGreaterThan(0)
    expect(await snapshot(["first", "deleted"])).toEqual(before)
  })

  test.each([false, true])("captured context cannot mutate after completion (rollback=%s)", async (rollback) => {
    let captured
    const operation = server.transaction((tx) => {
      captured = tx
      tx.writeRecord(id("captured"), { count: 1 })
      if (rollback) throw new Error("callback failed")
    })
    if (rollback) await expect(operation).rejects.toThrow("callback failed")
    else await operation
    const before = await snapshot(["captured"])
    await expect(Promise.resolve().then(() => captured.writeRecord(id("captured"), { count: 2 }))).rejects.toThrow()
    await expect(Promise.resolve().then(() => captured.deleteRecord(id("captured")))).rejects.toThrow()
    expect(await snapshot(["captured"])).toEqual(before)
  })

  test("callback throw rolls back staged writes and deletes and releases locks", async () => {
    await server.writeRecord(id("first"), { count: 0 })
    await server.writeRecord(id("deleted"), { keep: true })
    const names = ["first", "deleted", "new"]
    const before = await snapshot(names)
    const options = { records: names.map(id) }
    await expect(server.transaction(async (tx) => {
      tx.writeRecord(id("first"), { count: 1 })
      tx.deleteRecord(id("deleted"))
      tx.writeRecord(id("new"), { created: true })
      expect(await tx.getRecord(id("first"))).toEqual({ count: 1 })
      expect(await tx.getRecord(id("deleted"))).toBeNull()
      throw new Error("rollback sentinel")
    }, options)).rejects.toThrow("rollback sentinel")
    expect(await snapshot(names)).toEqual(before)
    await server.transaction((tx) => tx.writeRecord(id("first"), { count: 2 }), options)
    expect(await server.getRecord(id("first"))).toEqual({ count: 2 })
  })
  test("renewal keeps a long callback protected beyond the original lease", async () => {
    await server.transaction(async tx => {
      tx.writeRecord(id("renewed"), { ok: true })
      await new Promise(resolve => setTimeout(resolve, 10_200))
      const ttl = await server.recordManager.redis.pttl(`rt:record-lock:${id("renewed")}`)
      expect(ttl).toBeGreaterThan(0)
    }, { records: [id("renewed")] })
    expect(await server.getRecord(id("renewed"))).toEqual({ ok: true })
  }, 15_000)

  test("invalid later storage types cannot partially commit earlier writes", async () => {
    const redis = server.recordManager.redis
    await server.writeRecord(id("first"), { original: true })
    await redis.lpush(server.recordManager.recordVersionKey(id("bad")), "invalid")
    await expect(server.transaction(tx => {
      tx.writeRecord(id("first"), { changed: true })
      tx.writeRecord(id("bad"), { changed: true })
    })).rejects.toThrow()
    expect(await server.getRecord(id("first"))).toEqual({ original: true })
    expect(await server.getRecord(id("bad"))).toBeNull()
  })

  test("direct storage changes to a read record abort all staged writes", async () => {
    await server.writeRecord(id("read"), { count: 1 })
    await expect(server.transaction(async tx => {
      await tx.getRecord(id("read"))
      tx.writeRecord(id("other"), { changed: true })
      await server.recordManager.redis.set(server.recordManager.recordKey(id("read")), '{"count":2}')
    })).rejects.toThrow("changed outside")
    expect(await server.getRecord(id("other"))).toBeNull()
  })

  test("nested transactions and ordinary writes reject without deadlocking", async () => {
    await server.transaction(async tx => {
      await expect(server.transaction(() => {})).rejects.toThrow("context")
      await expect(server.writeRecord(id("nested"), {})).rejects.toThrow("context")
      tx.writeRecord(id("outer"), { ok: true })
    })
    expect(await server.getRecord(id("nested"))).toBeNull()
    expect(await server.getRecord(id("outer"))).toEqual({ ok: true })
  })

  test("staged inputs and returned reads cannot mutate stored state by reference", async () => {
    const value = { nested: { count: 1 } }
    await server.transaction(async tx => {
      tx.writeRecord(id("copy"), value)
      value.nested.count = 2
      const read = await tx.getRecord(id("copy"))
      read.nested.count = 3
    })
    expect(await server.getRecord(id("copy"))).toEqual({ nested: { count: 1 } })
  })

  test("duplicate batch records reject before any writes", async () => {
    await expect(server.transactionManager.commitBatch([
      { op: "write", recordId: id("duplicate"), value: { count: 1 } },
      { op: "delete", recordId: id("duplicate") },
    ])).rejects.toThrow("Duplicate")
    expect(await server.getRecord(id("duplicate"))).toBeNull()
  })

})
