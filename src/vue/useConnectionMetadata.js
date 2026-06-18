import { ref, onMounted, onBeforeUnmount } from 'vue'
import { injectRealtime } from './provide.js'

function isSet(value) {
  return value !== null && value !== undefined
}

/**
 * @typedef {Object} UseConnectionMetadataOptions
 * @property {import('../client/index.js').RealtimeClient} [client] - Client to use instead of the provided one. Defaults to the client from `provideRealtime`.
 * @property {*} [initial=null] - Initial metadata value. When non-null it is treated as the source of truth and pushed to the server on mount instead of fetching.
 */

/**
 * @typedef {Object} UseConnectionMetadataReturn
 * @property {import('vue').Ref<any>} metadata - The current connection metadata. The local ref is the source of truth and is re-pushed on reconnect.
 * @property {(value: any, opts?: Object) => Promise<boolean>} set - Write metadata through to the server, updating the local ref immediately. Resolves true on success.
 * @property {() => Promise<any>} refresh - Fetch the current metadata from the server and update the local ref. Resolves to the fetched value.
 * @property {import('vue').Ref<boolean>} loading - True while a fetch or refresh is in flight.
 * @property {import('vue').Ref<Error|null>} error - The last error from set or refresh, or null if none occurred.
 */

/**
 * Read and write metadata attached to the current connection. The local ref is
 * the source of truth: `set` writes through and the value is re-pushed on
 * reconnect, because a reconnect gets a fresh server-side connection. If
 * `initial` is provided it is pushed on mount; otherwise the value is fetched.
 * @param {UseConnectionMetadataOptions} [options] - Optional configuration.
 * @returns {UseConnectionMetadataReturn} Reactive metadata state plus `set` and `refresh` methods.
 */
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
