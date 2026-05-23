import { ref, shallowRef, onMounted, onBeforeUnmount, watch, isRef, unref } from 'vue'
import { injectRealtime } from './provide.js'

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
