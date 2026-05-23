import { ref, shallowRef, onMounted, onBeforeUnmount, watch, isRef, unref } from 'vue'
import { injectRealtime } from './provide.js'

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
