import { ref, shallowRef, onMounted, onBeforeUnmount, watch, isRef, unref } from 'vue'
import { injectRealtime } from './provide.js'

export function useChannel(channelName, options = {}) {
  const client = injectRealtime(options.client)
  const max = options.max ?? 200
  const messages = shallowRef([])
  const ready = ref(false)
  const error = ref(null)

  let mounted = false
  let currentName = null

  async function subscribe(name) {
    if (!name) return
    currentName = name
    try {
      const result = await client.subscribeChannel(name, (message) => {
        const next = messages.value.slice()
        next.push({ message, receivedAt: Date.now() })
        if (next.length > max) next.splice(0, next.length - max)
        messages.value = next
      })
      if (!mounted || currentName !== name) {
        try { await client.unsubscribeChannel(name) } catch {}
        return
      }
      if (result?.success) ready.value = true
    } catch (err) {
      error.value = err
    }
  }

  async function teardown(name) {
    if (!name) return
    try { await client.unsubscribeChannel(name) } catch {}
    ready.value = false
  }

  onMounted(async () => {
    mounted = true
    await subscribe(unref(channelName))
  })

  onBeforeUnmount(async () => {
    mounted = false
    await teardown(currentName)
  })

  if (isRef(channelName)) {
    watch(channelName, async (next, prev) => {
      if (prev) await teardown(prev)
      currentName = null
      messages.value = []
      if (next) await subscribe(next)
    })
  }

  function clear() { messages.value = [] }

  return { messages, ready, error, clear }
}
