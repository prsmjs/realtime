import { ref, shallowRef, onMounted, onBeforeUnmount, watch, isRef, unref } from 'vue'
import { injectRealtime } from './provide.js'

/**
 * @typedef {Object} UseChannelOptions
 * @property {import('../client/index.js').RealtimeClient} [client] - Client to use instead of the provided one. Defaults to the client from `provideRealtime`.
 * @property {number} [max=200] - Maximum messages retained in the rolling buffer. The oldest are dropped once the count exceeds this.
 */

/**
 * @typedef {Object} ChannelMessage
 * @property {*} message - The payload received on the channel.
 * @property {number} receivedAt - Client-side receipt timestamp in milliseconds since the epoch.
 */

/**
 * @typedef {Object} UseChannelReturn
 * @property {import('vue').ShallowRef<ChannelMessage[]>} messages - Received messages in arrival order, capped at the `max` option.
 * @property {import('vue').Ref<boolean>} ready - True once the channel subscription is established.
 * @property {import('vue').Ref<Error|null>} error - The last error from subscribing, or null if none occurred.
 * @property {() => void} clear - Empty the message buffer.
 */

/**
 * Subscribe to a channel and collect its messages into a rolling buffer.
 * Subscribes on mount and tears down on unmount. Pass a ref for `channelName`
 * to switch channels reactively; the buffer clears on switch.
 * @param {string|import('vue').Ref<string>} channelName - The channel to subscribe to, as a string or a ref for reactive switching.
 * @param {UseChannelOptions} [options] - Optional configuration.
 * @returns {UseChannelReturn} Reactive channel state plus a `clear` method.
 */
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
