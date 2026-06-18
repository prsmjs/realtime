import { ref, computed, onMounted, onBeforeUnmount, unref } from 'vue'
import { Status } from '../shared/index.js'
import { injectRealtime } from './provide.js'

const STATUS_NAME = {
  [Status.ONLINE]: 'online',
  [Status.CONNECTING]: 'connecting',
  [Status.RECONNECTING]: 'reconnecting',
  [Status.OFFLINE]: 'offline',
}

/**
 * @typedef {Object} UseConnectionOptions
 * @property {import('../client/index.js').RealtimeClient} [client] - Client to use instead of the provided one. Defaults to the client from `provideRealtime`.
 * @property {number|import('vue').Ref<number>} [grace=0] - Grace window in milliseconds. After a drop, `isStable` stays true for this long so gated UI does not unmount on a brief blip. The window opens from the first drop and a reconnect inside it cancels the timer. Defaults to 0 (no grace).
 */

/**
 * @typedef {Object} UseConnectionReturn
 * @property {import('vue').Ref<'online'|'connecting'|'reconnecting'|'offline'>} status - The current connection status as a lowercase string.
 * @property {import('vue').ComputedRef<boolean>} isOnline - True when the connection is online right now.
 * @property {import('vue').ComputedRef<boolean>} isReconnecting - True while the client is attempting to reconnect.
 * @property {import('vue').Ref<boolean>} isStable - True when online, and stays true through a drop for the grace window. Use this to gate UI that should survive brief disconnects.
 * @property {import('vue').Ref<number|null>} latency - Last measured round-trip latency in milliseconds, or null before the first measurement.
 * @property {import('vue').Ref<boolean>} hasConnected - True once the client has been online at least once. Stays true after later drops.
 */

/**
 * Observe the connection's status and latency. This composable only reads
 * client status and events; it never opens, closes, or reconnects the
 * connection (the client does that on its own). Use `isStable` rather than
 * `isOnline` to gate UI when you want it to survive brief disconnects.
 * @param {UseConnectionOptions} [options] - Optional configuration.
 * @returns {UseConnectionReturn} Reactive connection state.
 */
export function useConnection(options = {}) {
  const client = injectRealtime(options.client)
  const grace = options.grace ?? 0

  const online = () => client.status === Status.ONLINE

  const status = ref(STATUS_NAME[client.status] ?? 'offline')
  const latency = ref(null)
  const hasConnected = ref(online())
  const isStable = ref(online())

  const isOnline = computed(() => status.value === 'online')
  const isReconnecting = computed(() => status.value === 'reconnecting')

  let graceTimer = null

  function clearGrace() {
    if (graceTimer) {
      clearTimeout(graceTimer)
      graceTimer = null
    }
  }

  function sync() {
    status.value = STATUS_NAME[client.status] ?? 'offline'

    if (online()) {
      hasConnected.value = true
      clearGrace()
      isStable.value = true
      return
    }

    const ms = unref(grace)
    if (!ms || ms <= 0) {
      clearGrace()
      isStable.value = false
      return
    }

    // hold the stable window open from the first drop; a reconnect inside it
    // cancels the timer so children never unmount on a brief blip
    if (!graceTimer) {
      graceTimer = setTimeout(() => {
        graceTimer = null
        if (!online()) isStable.value = false
      }, ms)
    }
  }

  function onLatency(value) {
    latency.value = value
  }

  onMounted(() => {
    client.on('connect', sync)
    client.on('disconnect', sync)
    client.on('reconnect', sync)
    client.on('reconnectfailed', sync)
    client.on('latency', onLatency)
    sync()
  })

  onBeforeUnmount(() => {
    client.off('connect', sync)
    client.off('disconnect', sync)
    client.off('reconnect', sync)
    client.off('reconnectfailed', sync)
    client.off('latency', onLatency)
    clearGrace()
  })

  return { status, isOnline, isReconnecting, isStable, latency, hasConnected }
}
