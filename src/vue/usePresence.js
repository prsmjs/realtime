import { ref, shallowRef, onMounted, onBeforeUnmount, watch, isRef, unref } from 'vue'
import { injectRealtime } from './provide.js'

/**
 * @typedef {Object} UsePresenceOptions
 * @property {import('../client/index.js').RealtimeClient} [client] - Client to use instead of the provided one. Defaults to the client from `provideRealtime`.
 * @property {boolean} [autoJoin=true] - Whether to join the room before subscribing to presence (true). Set false if the room is already joined elsewhere.
 * @property {*} [initial=null] - Initial value for the local presence state. When non-null it is published once subscribed.
 */

/**
 * @typedef {Object} UsePresenceReturn
 * @property {import('vue').Ref<any>} me - Your own presence state. Writing to it (including deep mutations) publishes the new state to the room.
 * @property {import('vue').ShallowRef<Record<string, any>>} others - Other connections' presence keyed by connection ID. Updated as peers join, change, or leave.
 */

/**
 * Track presence in a room and publish your own state. Subscribes on mount and
 * tears down on unmount; assigning to the returned `me` ref publishes your
 * state. Pass a ref for `roomName` to switch rooms reactively.
 * @param {string|import('vue').Ref<string>} roomName - The room whose presence to track, as a string or a ref for reactive switching.
 * @param {UsePresenceOptions} [options] - Optional configuration.
 * @returns {UsePresenceReturn} Reactive presence state.
 */
export function usePresence(roomName, options = {}) {
  const client = injectRealtime(options.client)
  const autoJoin = options.autoJoin !== false
  const me = ref(options.initial ?? null)
  const others = shallowRef({})
  let mounted = false
  let currentName = null
  let didJoin = false

  async function subscribe(name) {
    if (!name) return
    currentName = name
    try {
      if (autoJoin) {
        const join = await client.joinRoom(name)
        didJoin = !!join?.success
      }
      const result = await client.subscribePresence(name, (update) => {
        if (!update) return
        if (update.states) others.value = { ...update.states }
        if (update.connectionId && update.state) {
          others.value = { ...others.value, [update.connectionId]: update.state }
        }
        if (update.connectionId && update.removed) {
          const next = { ...others.value }
          delete next[update.connectionId]
          others.value = next
        }
      })
      if (!mounted || currentName !== name) {
        try { await client.unsubscribePresence(name) } catch {}
        if (didJoin) { try { await client.leaveRoom(name) } catch {} }
        return
      }
      if (result?.states) others.value = { ...result.states }
      if (me.value !== null) {
        await client.publishPresenceState(name, { state: me.value }).catch(() => {})
      }
    } catch {}
  }

  async function teardown(name) {
    if (!name) return
    try { await client.unsubscribePresence(name) } catch {}
    if (didJoin) {
      try { await client.leaveRoom(name) } catch {}
      didJoin = false
    }
  }

  onMounted(async () => {
    mounted = true
    await subscribe(unref(roomName))
  })

  onBeforeUnmount(async () => {
    mounted = false
    await teardown(currentName)
  })

  if (isRef(roomName)) {
    watch(roomName, async (next, prev) => {
      if (prev) await teardown(prev)
      if (next) await subscribe(next)
    })
  }

  watch(me, async (state) => {
    if (!currentName || state === null) return
    try { await client.publishPresenceState(currentName, { state }) } catch {}
  }, { deep: true })

  return { me, others }
}
