// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { WebSocket as NodeWebSocket } from 'ws'
import { defineComponent, h, ref, nextTick } from 'vue'
import { mount } from '@vue/test-utils'
import { RealtimeServer } from '../../src/index.js'
import { RealtimeClient } from '../../src/client/index.js'
import {
  provideRealtime,
  useRoom,
  usePresence,
  useRecord,
  useChannel,
  useCollection,
  useConnection,
  useConnectionMetadata,
  RealtimeRoom,
  RealtimePresence,
  RealtimeRecord,
} from '../../src/vue/index.js'
import { createTestContext, wait } from '../helpers.js'

let ctx, server, client

async function bootServer(opts = {}) {
  server = new RealtimeServer({ redis: ctx.redisOptions, ...opts })
  await server.listen(0)
  return server
}

async function bootClient() {
  client = new RealtimeClient(`ws://localhost:${server.port}`)
  await client.connect()
  return client
}

function mountWithClient(component, props = {}) {
  const wrapper = defineComponent({
    props: ['inner'],
    setup(p) {
      provideRealtime(client)
      return () => h(component, props)
    },
  })
  return mount(wrapper, { props: { inner: component } })
}

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

describe('useRoom', () => {
  it('joins on mount, leaves on unmount (server-side observable)', async () => {
    await bootServer()
    await bootClient()

    const Comp = defineComponent({
      setup() {
        const room = useRoom('lobby')
        return () => h('div', `members:${room.members.value.length}`)
      },
    })

    const wrapper = mountWithClient(Comp)
    await wait(150)

    const membersBefore = await server.roomManager.getRoomConnectionIds('lobby')
    expect(membersBefore.length).toBe(1)
    expect(membersBefore[0]).toBe(client.connectionId)

    wrapper.unmount()
    await wait(150)

    const membersAfter = await server.roomManager.getRoomConnectionIds('lobby')
    expect(membersAfter.length).toBe(0)
  })

  it('exposes room members reactively when others join', async () => {
    await bootServer()
    await bootClient()

    const Comp = defineComponent({
      setup() {
        const room = useRoom('chat')
        return () => h('div', { 'data-count': room.members.value.length })
      },
    })

    const wrapper = mountWithClient(Comp)
    await wait(100)

    const other = new RealtimeClient(`ws://localhost:${server.port}`)
    await other.connect()
    await other.joinRoom('chat')
    await wait(150)

    const members = await server.roomManager.getRoomConnectionIds('chat')
    expect(members.length).toBe(2)

    await other.close()
    wrapper.unmount()
  })
})

describe('useRecord', () => {
  it('subscribes on mount and receives writes from another client', async () => {
    await bootServer()
    server.exposeRecord(/^doc:.+$/)
    server.exposeWritableRecord(/^doc:.+$/)
    await bootClient()

    await server.writeRecord('doc:1', { title: 'hello', count: 0 })
    await wait(50)

    const Comp = defineComponent({
      setup() {
        const rec = useRecord('doc:1')
        return () => h('div', { 'data-title': rec.value.value?.title ?? '' })
      },
    })

    const wrapper = mountWithClient(Comp)
    await wait(150)

    const subs = server.recordSubscriptionManager.recordSubscriptions
    const subsBefore = subs.get('doc:1')?.size ?? 0
    expect(subsBefore).toBe(1)

    await server.writeRecord('doc:1', { title: 'updated', count: 1 })
    await wait(150)

    expect(wrapper.element.getAttribute('data-title')).toBe('updated')

    wrapper.unmount()
    await wait(150)

    const subsAfter = subs.get('doc:1')?.size ?? 0
    expect(subsAfter).toBe(0)
  })

  it('write() writes back through the client', async () => {
    await bootServer()
    server.exposeRecord(/^doc:.+$/)
    server.exposeWritableRecord(/^doc:.+$/)
    await bootClient()
    await server.writeRecord('doc:2', { n: 0 })

    let writeFn
    const Comp = defineComponent({
      setup() {
        const rec = useRecord('doc:2')
        writeFn = rec.write
        return () => h('div')
      },
    })

    const wrapper = mountWithClient(Comp)
    await wait(150)

    await writeFn({ n: 42 })
    await wait(100)

    const stored = await server.recordManager.getRecord('doc:2')
    expect(stored).toEqual({ n: 42 })

    wrapper.unmount()
  })
})

describe('useChannel', () => {
  it('subscribes on mount and accumulates messages, unsubscribes on unmount', async () => {
    await bootServer()
    server.exposeChannel(/^notif$/)
    await bootClient()

    const Comp = defineComponent({
      setup() {
        const ch = useChannel('notif')
        return () => h('div', { 'data-count': ch.messages.value.length })
      },
    })

    const wrapper = mountWithClient(Comp)
    await wait(150)

    const subsBefore = Object.keys(server.channelManager.channelSubscriptions['notif'] ? { notif: 1 } : {}).length
    expect(server.channelManager.channelSubscriptions['notif']?.size ?? 0).toBe(1)

    await server.writeChannel('notif', { text: 'one' })
    await server.writeChannel('notif', { text: 'two' })
    await wait(200)

    expect(wrapper.element.getAttribute('data-count')).toBe('2')

    wrapper.unmount()
    await wait(150)

    expect(server.channelManager.channelSubscriptions['notif']?.size ?? 0).toBe(0)
  })
})

describe('useCollection', () => {
  it('subscribes and unsubscribes from a collection', async () => {
    await bootServer()
    server.exposeRecord(/^item:.+$/)
    server.exposeCollection(/^bag$/, () => ([{ id: 'item:a' }, { id: 'item:b' }]))
    await server.writeRecord('item:a', { name: 'a' })
    await server.writeRecord('item:b', { name: 'b' })
    await bootClient()

    const Comp = defineComponent({
      setup() {
        const c = useCollection('bag')
        return () => h('div', { 'data-count': c.items.value.length })
      },
    })

    const wrapper = mountWithClient(Comp)
    await wait(200)

    const subs = server.collectionManager.collectionSubscriptions
    expect(subs.get('bag')?.size ?? 0).toBe(1)

    wrapper.unmount()
    await wait(150)

    expect(subs.get('bag')?.size ?? 0).toBe(0)
  })
})

describe('usePresence', () => {
  it('publishes initial state on mount and updates server-side state on me change', async () => {
    await bootServer()
    server.trackPresence(/^room:.+$/)
    await bootClient()

    let setMe
    const Comp = defineComponent({
      setup() {
        const presence = usePresence('room:a', { initial: { status: 'online' } })
        setMe = (s) => { presence.me.value = s }
        return () => h('div')
      },
    })

    const wrapper = mountWithClient(Comp)
    await wait(150)

    const before = await server.presenceManager.getPresenceState(client.connectionId, 'room:a')
    expect(before).toEqual({ status: 'online' })

    setMe({ status: 'typing' })
    await wait(150)

    const after = await server.presenceManager.getPresenceState(client.connectionId, 'room:a')
    expect(after).toEqual({ status: 'typing' })

    wrapper.unmount()
  })
})

describe('renderless components', () => {
  it('<RealtimeRoom> joins/leaves on mount/unmount', async () => {
    await bootServer()
    await bootClient()

    const Comp = defineComponent({
      setup() {
        return () => h(RealtimeRoom, { name: 'x' }, {
          default: ({ members }) => h('div', { 'data-count': members.value.length }),
        })
      },
    })

    const wrapper = mountWithClient(Comp)
    await wait(150)
    expect((await server.roomManager.getRoomConnectionIds('x')).length).toBe(1)

    wrapper.unmount()
    await wait(150)
    expect((await server.roomManager.getRoomConnectionIds('x')).length).toBe(0)
  })

  it('<RealtimeRecord> subscribes via scoped slot', async () => {
    await bootServer()
    server.exposeRecord(/^d:.+$/)
    await server.writeRecord('d:1', { v: 0 })
    await bootClient()

    const Comp = defineComponent({
      setup() {
        return () => h(RealtimeRecord, { id: 'd:1' }, {
          default: ({ value }) => h('div', { 'data-v': value.value?.v ?? '' }),
        })
      },
    })

    const wrapper = mountWithClient(Comp)
    await wait(300)
    await nextTick()
    const inner = () => wrapper.element.querySelector('[data-v]') ?? wrapper.element
    expect(inner().getAttribute('data-v')).toBe('0')

    await server.writeRecord('d:1', { v: 9 })
    await wait(200)
    await nextTick()
    expect(inner().getAttribute('data-v')).toBe('9')

    wrapper.unmount()
    await wait(150)
    expect(server.recordSubscriptionManager.recordSubscriptions.get('d:1')?.size ?? 0).toBe(0)
  })
})

describe('useConnection (integration)', () => {
  it('reflects online status after connect and exposes hasConnected', async () => {
    await bootServer()
    await bootClient()

    let api
    const Comp = defineComponent({
      setup() {
        api = useConnection()
        return () => h('div', api.status.value)
      },
    })

    const wrapper = mountWithClient(Comp)
    await wait(100)

    expect(api.status.value).toBe('online')
    expect(api.isOnline.value).toBe(true)
    expect(api.hasConnected.value).toBe(true)

    wrapper.unmount()
  })

  it('drops to offline when the client closes', async () => {
    await bootServer()
    await bootClient()

    let api
    const Comp = defineComponent({
      setup() {
        api = useConnection({ grace: 0 })
        return () => h('div')
      },
    })

    const wrapper = mountWithClient(Comp)
    await wait(100)
    expect(api.isStable.value).toBe(true)

    await client.close()
    await wait(100)

    expect(api.isOnline.value).toBe(false)
    expect(api.isStable.value).toBe(false)

    wrapper.unmount()
  })
})

describe('useConnectionMetadata (integration)', () => {
  it('writes through to the server and reads back', async () => {
    await bootServer()
    await bootClient()

    let api
    const Comp = defineComponent({
      setup() {
        api = useConnectionMetadata()
        return () => h('div')
      },
    })

    const wrapper = mountWithClient(Comp)
    await wait(100)

    await api.set({ name: 'ada', role: 'admin' })
    await wait(100)

    const fresh = await api.refresh()
    expect(fresh).toEqual({ name: 'ada', role: 'admin' })
    expect(api.metadata.value).toEqual({ name: 'ada', role: 'admin' })

    wrapper.unmount()
  })
})

describe('error handling', () => {
  it('throws when injectRealtime cannot find a client', async () => {
    await bootServer()
    await bootClient()

    const Comp = defineComponent({
      setup() {
        return () => h('div')
      },
    })

    // Mount without provide
    const Bad = defineComponent({
      setup() {
        try { useRoom('z') } catch (err) { return () => h('div', { 'data-err': err.message }) }
        return () => h('div')
      },
    })

    let captured
    const handler = (err) => { captured = err }
    const wrapper = mount(Bad, { global: { config: { errorHandler: handler } } })
    await wait(100)
    expect(captured?.message ?? wrapper.element.getAttribute('data-err') ?? '').toMatch(/No RealtimeClient/i)
    wrapper.unmount()
  })
})
