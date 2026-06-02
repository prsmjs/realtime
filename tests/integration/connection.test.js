// @vitest-environment happy-dom
import { describe, it, expect, vi } from 'vitest'
import { EventEmitter } from 'eventemitter3'
import { defineComponent, h, nextTick } from 'vue'
import { mount, flushPromises } from '@vue/test-utils'
import { Status } from '../../src/shared/index.js'
import { useConnection, useConnectionMetadata, RealtimeStatus } from '../../src/vue/index.js'

function fakeClient(status = Status.OFFLINE) {
  const client = new EventEmitter()
  client.status = status
  client._meta = null
  client.getConnectionMetadata = vi.fn(async () => client._meta)
  client.setConnectionMetadata = vi.fn(async (m) => { client._meta = m; return true })
  return client
}

function mountWith(factory) {
  let api
  const Comp = defineComponent({
    setup() {
      api = factory()
      return () => h('div')
    },
  })
  const wrapper = mount(Comp)
  return { api: () => api, wrapper }
}

describe('useConnection grace window', () => {
  it('grace=0 flips isStable false immediately on a drop', () => {
    const c = fakeClient(Status.ONLINE)
    const { api, wrapper } = mountWith(() => useConnection({ client: c, grace: 0 }))

    expect(api().isStable.value).toBe(true)

    c.status = Status.RECONNECTING
    c.emit('disconnect')

    expect(api().isStable.value).toBe(false)
    expect(api().status.value).toBe('reconnecting')

    wrapper.unmount()
  })

  it('grace>0 holds isStable through the window, then flips', () => {
    vi.useFakeTimers()
    try {
      const c = fakeClient(Status.ONLINE)
      const { api, wrapper } = mountWith(() => useConnection({ client: c, grace: 500 }))

      c.status = Status.RECONNECTING
      c.emit('disconnect')
      expect(api().isStable.value).toBe(true)

      vi.advanceTimersByTime(499)
      expect(api().isStable.value).toBe(true)

      vi.advanceTimersByTime(2)
      expect(api().isStable.value).toBe(false)

      wrapper.unmount()
    } finally {
      vi.useRealTimers()
    }
  })

  it('reconnect inside the grace window keeps isStable true (no flicker)', () => {
    vi.useFakeTimers()
    try {
      const c = fakeClient(Status.ONLINE)
      const { api, wrapper } = mountWith(() => useConnection({ client: c, grace: 500 }))

      c.status = Status.RECONNECTING
      c.emit('disconnect')
      vi.advanceTimersByTime(200)
      expect(api().isStable.value).toBe(true)

      c.status = Status.ONLINE
      c.emit('reconnect')
      vi.advanceTimersByTime(1000)

      expect(api().isStable.value).toBe(true)
      expect(api().isOnline.value).toBe(true)

      wrapper.unmount()
    } finally {
      vi.useRealTimers()
    }
  })

  it('a single grace window spans repeated drops without resetting', () => {
    vi.useFakeTimers()
    try {
      const c = fakeClient(Status.ONLINE)
      const { api, wrapper } = mountWith(() => useConnection({ client: c, grace: 500 }))

      c.status = Status.RECONNECTING
      c.emit('disconnect')
      vi.advanceTimersByTime(400)

      c.emit('disconnect')
      vi.advanceTimersByTime(101)

      expect(api().isStable.value).toBe(false)

      wrapper.unmount()
    } finally {
      vi.useRealTimers()
    }
  })

  it('tracks latency events', () => {
    const c = fakeClient(Status.ONLINE)
    const { api, wrapper } = mountWith(() => useConnection({ client: c }))

    expect(api().latency.value).toBe(null)
    c.emit('latency', 42)
    expect(api().latency.value).toBe(42)

    wrapper.unmount()
  })

  it('sets hasConnected on first online and keeps it after a drop', () => {
    const c = fakeClient(Status.OFFLINE)
    const { api, wrapper } = mountWith(() => useConnection({ client: c, grace: 0 }))

    expect(api().hasConnected.value).toBe(false)

    c.status = Status.ONLINE
    c.emit('connect')
    expect(api().hasConnected.value).toBe(true)

    c.status = Status.OFFLINE
    c.emit('disconnect')
    expect(api().hasConnected.value).toBe(true)
    expect(api().isOnline.value).toBe(false)

    wrapper.unmount()
  })
})

describe('useConnectionMetadata', () => {
  it('pushes an initial local value and treats local as source of truth', () => {
    const c = fakeClient(Status.ONLINE)
    const { api, wrapper } = mountWith(() => useConnectionMetadata({ client: c, initial: { name: 'ada' } }))

    expect(c.setConnectionMetadata).toHaveBeenCalledWith({ name: 'ada' })
    expect(api().metadata.value).toEqual({ name: 'ada' })

    wrapper.unmount()
  })

  it('re-pushes local metadata on reconnect', () => {
    const c = fakeClient(Status.ONLINE)
    const { wrapper } = mountWith(() => useConnectionMetadata({ client: c, initial: { name: 'ada' } }))

    c.setConnectionMetadata.mockClear()
    c.emit('reconnect')

    expect(c.setConnectionMetadata).toHaveBeenCalledWith({ name: 'ada' })

    wrapper.unmount()
  })

  it('fetches from the server when no initial value is provided', async () => {
    const c = fakeClient(Status.ONLINE)
    c._meta = { role: 'admin' }
    const { api, wrapper } = mountWith(() => useConnectionMetadata({ client: c }))

    await flushPromises()

    expect(c.getConnectionMetadata).toHaveBeenCalled()
    expect(api().metadata.value).toEqual({ role: 'admin' })

    wrapper.unmount()
  })

  it('set updates the local ref then writes through to the server', async () => {
    const c = fakeClient(Status.ONLINE)
    const { api, wrapper } = mountWith(() => useConnectionMetadata({ client: c }))

    await flushPromises()
    const ok = await api().set({ theme: 'dark' })

    expect(ok).toBe(true)
    expect(api().metadata.value).toEqual({ theme: 'dark' })
    expect(c.setConnectionMetadata).toHaveBeenCalledWith({ theme: 'dark' }, undefined)

    wrapper.unmount()
  })
})

describe('RealtimeStatus', () => {
  function mountStatus(client, grace = 0) {
    const Comp = defineComponent({
      setup() {
        return () => h(RealtimeStatus, { client, grace }, {
          online: () => h('div', { 'data-slot': 'online' }),
          reconnecting: () => h('div', { 'data-slot': 'reconnecting' }),
          offline: () => h('div', { 'data-slot': 'offline' }),
        })
      },
    })
    return mount(Comp)
  }

  it('renders the online slot while stable and swaps slots as state changes', async () => {
    const c = fakeClient(Status.ONLINE)
    const wrapper = mountStatus(c, 0)
    await nextTick()
    expect(wrapper.find('[data-slot="online"]').exists()).toBe(true)

    c.status = Status.RECONNECTING
    c.emit('disconnect')
    await nextTick()
    expect(wrapper.find('[data-slot="reconnecting"]').exists()).toBe(true)

    c.status = Status.OFFLINE
    c.emit('reconnectfailed')
    await nextTick()
    expect(wrapper.find('[data-slot="offline"]').exists()).toBe(true)

    wrapper.unmount()
  })

  it('keeps the online slot mounted through a drop within the grace window', () => {
    vi.useFakeTimers()
    try {
      const c = fakeClient(Status.ONLINE)
      const wrapper = mountStatus(c, 500)

      c.status = Status.RECONNECTING
      c.emit('disconnect')
      vi.advanceTimersByTime(200)
      expect(wrapper.find('[data-slot="online"]').exists()).toBe(true)

      c.status = Status.ONLINE
      c.emit('reconnect')
      vi.advanceTimersByTime(1000)
      expect(wrapper.find('[data-slot="online"]').exists()).toBe(true)

      wrapper.unmount()
    } finally {
      vi.useRealTimers()
    }
  })
})
