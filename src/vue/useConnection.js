import { ref, computed, onMounted, onBeforeUnmount, unref } from 'vue'
import { Status } from '../shared/index.js'
import { injectRealtime } from './provide.js'

const STATUS_NAME = {
  [Status.ONLINE]: 'online',
  [Status.CONNECTING]: 'connecting',
  [Status.RECONNECTING]: 'reconnecting',
  [Status.OFFLINE]: 'offline',
}

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
