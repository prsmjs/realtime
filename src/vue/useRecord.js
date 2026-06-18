import { ref, shallowRef, onMounted, onBeforeUnmount, watch, isRef, unref } from 'vue'
import { injectRealtime } from './provide.js'

/**
 * @typedef {Object} UseRecordOptions
 * @property {import('../client/index.js').RealtimeClient} [client] - Client to use instead of the provided one. Defaults to the client from `provideRealtime`.
 * @property {'full'|'patch'} [mode='full'] - Update delivery mode. 'full' replaces the value on each update; 'patch' subscribes for incremental patches.
 */

/**
 * @typedef {Object} UseRecordReturn
 * @property {import('vue').ShallowRef<any>} value - The current record value, or null until the first load completes.
 * @property {import('vue').Ref<number>} version - The record's version number, incremented by the server on each write.
 * @property {import('vue').Ref<boolean>} ready - True once the initial record state has loaded.
 * @property {import('vue').Ref<Error|null>} error - The last error from subscribing, or null if none occurred.
 * @property {(newValue: any, writeOpts?: Object) => Promise<any>} write - Write a new value to the record. Rejects if called before the subscription is established.
 */

/**
 * Subscribe to a record and read its live value. Subscribes on mount and tears
 * down on unmount. Pass a ref for `recordId` to follow a different record
 * reactively; the value resets to null while the new subscription loads.
 * @param {string|import('vue').Ref<string>} recordId - The record to subscribe to, as a string or a ref for reactive switching.
 * @param {UseRecordOptions} [options] - Optional configuration.
 * @returns {UseRecordReturn} Reactive record state plus a `write` method.
 */
export function useRecord(recordId, options = {}) {
  const client = injectRealtime(options.client)
  const value = shallowRef(null)
  const version = ref(0)
  const ready = ref(false)
  const error = ref(null)
  const mode = options.mode ?? 'full'

  let mounted = false
  let currentId = null

  async function subscribe(id) {
    if (!id) return
    currentId = id
    try {
      const result = await client.subscribeRecord(id, (update) => {
        if (!update) return
        if (update.full !== undefined) value.value = update.full
        else if (update.value !== undefined) value.value = update.value
        if (typeof update.version === 'number') version.value = update.version
      }, mode === 'patch' ? { mode: 'patch' } : undefined)
      if (!mounted || currentId !== id) {
        try { await client.unsubscribeRecord(id) } catch {}
        return
      }
      if (result?.record !== undefined && result?.record !== null) value.value = result.record
      if (typeof result?.version === 'number') version.value = result.version
      ready.value = true
    } catch (err) {
      error.value = err
    }
  }

  async function teardown(id) {
    if (!id) return
    try { await client.unsubscribeRecord(id) } catch {}
    ready.value = false
  }

  onMounted(async () => {
    mounted = true
    await subscribe(unref(recordId))
  })

  onBeforeUnmount(async () => {
    mounted = false
    await teardown(currentId)
  })

  if (isRef(recordId)) {
    watch(recordId, async (next, prev) => {
      if (prev) await teardown(prev)
      currentId = null
      value.value = null
      if (next) await subscribe(next)
    })
  }

  async function write(newValue, writeOpts) {
    if (!currentId) throw new Error('useRecord: not subscribed yet')
    return await client.writeRecord(currentId, newValue, writeOpts)
  }

  return { value, version, ready, error, write }
}
