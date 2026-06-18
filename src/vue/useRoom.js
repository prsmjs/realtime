import { ref, shallowRef, onMounted, onBeforeUnmount, watch, isRef, unref } from 'vue'
import { injectRealtime } from './provide.js'

/**
 * @typedef {Object} UseRoomOptions
 * @property {import('../client/index.js').RealtimeClient} [client] - Client to use instead of the provided one. Defaults to the client from `provideRealtime`.
 */

/**
 * @typedef {Object} UseRoomReturn
 * @property {import('vue').ShallowRef<string[]>} members - Connection IDs currently in the room. Replaced on every membership change.
 * @property {import('vue').ShallowRef<Record<string, any>>} presence - Per-connection presence state keyed by connection ID, merged as updates arrive.
 * @property {import('vue').Ref<boolean>} joined - True once the join has completed and the room is being tracked.
 * @property {import('vue').Ref<Error|null>} error - The last error from joining the room, or null if none occurred.
 */

/**
 * Join a room and track its membership and presence. Joins on mount and leaves
 * on unmount. Pass a ref for `roomName` to switch rooms reactively; the old
 * room is left and the new one joined automatically.
 * @param {string|import('vue').Ref<string>} roomName - The room to join, as a plain string or a ref for reactive room switching.
 * @param {UseRoomOptions} [options] - Optional configuration.
 * @returns {UseRoomReturn} Reactive room state.
 */
export function useRoom(roomName, options = {}) {
  const client = injectRealtime(options.client)
  const members = shallowRef([])
  const presence = shallowRef({})
  const joined = ref(false)
  const error = ref(null)

  let currentName = null
  let mounted = false

  function applyPresence(update) {
    presence.value = { ...presence.value, ...update }
  }

  async function joinName(name) {
    if (!name) return
    currentName = name
    try {
      const result = await client.joinRoom(name, (update) => {
        if (!update) return
        if (update.members) members.value = [...update.members]
        if (update.presence) presence.value = { ...update.presence }
        if (update.state && update.connectionId) {
          applyPresence({ [update.connectionId]: update.state })
        }
      })
      if (!mounted || currentName !== name) {
        await client.leaveRoom(name).catch(() => {})
        return
      }
      if (result?.members) members.value = [...result.members]
      if (result?.presence) presence.value = { ...result.presence }
      joined.value = true
    } catch (err) {
      error.value = err
    }
  }

  async function leaveName(name) {
    if (!name) return
    joined.value = false
    try { await client.leaveRoom(name) } catch {}
  }

  onMounted(async () => {
    mounted = true
    await joinName(unref(roomName))
  })

  onBeforeUnmount(async () => {
    mounted = false
    await leaveName(currentName)
  })

  if (isRef(roomName)) {
    watch(roomName, async (next, prev) => {
      if (prev) await leaveName(prev)
      if (next) await joinName(next)
    })
  }

  return { members, presence, joined, error }
}
