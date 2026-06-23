import { ref, shallowRef, onMounted, onBeforeUnmount, watch, isRef, unref } from 'vue'
import { injectRealtime } from './provide.js'

/**
 * @typedef {Object} UseCollectionOptions
 * @property {import('../client/index.js').RealtimeClient} [client] - Client to use instead of the provided one. Defaults to the client from `provideRealtime`.
 */

/**
 * @typedef {Object} UseCollectionReturn
 * @property {import('vue').ShallowRef<any[]>} items - The collection's records, kept in sync as items are added, changed, or removed.
 * @property {import('vue').Ref<number>} version - The collection's version number, advanced by the server on each diff.
 * @property {import('vue').Ref<boolean>} ready - True once the initial collection snapshot has loaded.
 * @property {import('vue').Ref<Error|null>} error - The last error from subscribing, or null if none occurred.
 */

/**
 * Subscribe to a collection and keep a live array of its records. Subscribes on
 * mount and tears down on unmount, applying server diffs (added, changed,
 * removed) to the local `items`. Pass a ref for `collectionId` to switch
 * collections reactively; `items` resets on switch.
 * @param {string|import('vue').Ref<string>} collectionId - The collection to subscribe to, as a string or a ref for reactive switching.
 * @param {UseCollectionOptions} [options] - Optional configuration.
 * @returns {UseCollectionReturn} Reactive collection state.
 */
export function useCollection(collectionId, options = {}) {
  const client = injectRealtime(options.client)
  const items = shallowRef([])
  const version = ref(0)
  const ready = ref(false)
  const error = ref(null)

  let mounted = false
  let currentId = null

  async function subscribe(id) {
    if (!id) return
    currentId = id
    try {
      const result = await client.subscribeCollection(id, {
        onDiff: (diff) => {
          if (!diff) return
          let next = items.value.slice()
          if (Array.isArray(diff.added)) {
            for (const entry of diff.added) {
              const idx = next.findIndex((x) => x.id === entry.id)
              if (idx === -1) next.push(entry.record ?? entry)
              else next[idx] = entry.record ?? entry
            }
          }
          if (Array.isArray(diff.removed)) {
            const removedIds = new Set(diff.removed.map((e) => e.id))
            next = next.filter((x) => !removedIds.has(x.id))
          }
          if (Array.isArray(diff.changed)) {
            for (const entry of diff.changed) {
              const idx = next.findIndex((x) => x.id === entry.id)
              if (idx !== -1) next[idx] = entry.record ?? entry
            }
          }
          items.value = next
          if (typeof diff.version === 'number') version.value = diff.version
        },
      })
      if (!mounted || currentId !== id) {
        try { await client.unsubscribeCollection(id) } catch {}
        return
      }
      if (Array.isArray(result?.records)) items.value = result.records.map((e) => e.record ?? e)
      if (typeof result?.version === 'number') version.value = result.version
      ready.value = result?.success === true
    } catch (err) {
      error.value = err
    }
  }

  async function teardown(id) {
    if (!id) return
    try { await client.unsubscribeCollection(id) } catch {}
    ready.value = false
  }

  onMounted(async () => {
    mounted = true
    await subscribe(unref(collectionId))
  })

  onBeforeUnmount(async () => {
    mounted = false
    await teardown(currentId)
  })

  if (isRef(collectionId)) {
    watch(collectionId, async (next, prev) => {
      if (prev) await teardown(prev)
      currentId = null
      items.value = []
      if (next) await subscribe(next)
    })
  }

  return { items, version, ready, error }
}
