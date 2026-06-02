import { ref, onMounted, onBeforeUnmount } from 'vue'
import { injectRealtime } from './provide.js'

function isSet(value) {
  return value !== null && value !== undefined
}

export function useConnectionMetadata(options = {}) {
  const client = injectRealtime(options.client)
  const metadata = ref(options.initial ?? null)
  const loading = ref(false)
  const error = ref(null)
  let mounted = false

  async function refresh() {
    loading.value = true
    try {
      const value = await client.getConnectionMetadata()
      if (mounted) metadata.value = value ?? null
      return value
    } catch (err) {
      error.value = err
      return null
    } finally {
      loading.value = false
    }
  }

  async function set(value, opts) {
    metadata.value = value
    try {
      const ok = await client.setConnectionMetadata(value, opts)
      if (!ok) error.value = new Error('failed to set connection metadata')
      return ok
    } catch (err) {
      error.value = err
      return false
    }
  }

  // a reconnect gets a fresh connection on the server, so the local ref is the
  // source of truth - re-push whatever we hold
  function repush() {
    if (isSet(metadata.value)) {
      client.setConnectionMetadata(metadata.value).catch(() => {})
    }
  }

  onMounted(async () => {
    mounted = true
    client.on('reconnect', repush)
    if (isSet(metadata.value)) {
      repush()
    } else {
      await refresh()
    }
  })

  onBeforeUnmount(() => {
    mounted = false
    client.off('reconnect', repush)
  })

  return { metadata, set, refresh, loading, error }
}
