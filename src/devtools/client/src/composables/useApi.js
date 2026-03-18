import { ref, onMounted, onUnmounted } from 'vue'

export function useApi(pollInterval = 1000) {
  const state = ref(null)
  const connectionDetail = ref(null)
  const selectedConnectionId = ref(null)
  const error = ref(null)
  let timer = null

  const basePath = import.meta.env.DEV ? '' : '.'

  async function fetchState() {
    try {
      const res = await fetch(`${basePath}/api/state`)
      if (!res.ok) throw new Error(`${res.status}`)
      state.value = await res.json()
      error.value = null
    } catch (e) {
      error.value = e.message
    }
  }

  async function fetchConnectionDetail(id) {
    try {
      const res = await fetch(`${basePath}/api/connection/${id}`)
      if (!res.ok) throw new Error(`${res.status}`)
      connectionDetail.value = await res.json()
    } catch {}
  }

  async function fetchCollectionRecords(collId, connId) {
    try {
      const res = await fetch(`${basePath}/api/collection/${encodeURIComponent(collId)}/records?connId=${encodeURIComponent(connId)}`)
      if (!res.ok) throw new Error(`${res.status}`)
      return await res.json()
    } catch {
      return { recordIds: [], records: [] }
    }
  }

  async function selectConnection(id) {
    selectedConnectionId.value = id
    if (id) await fetchConnectionDetail(id)
    else connectionDetail.value = null
  }

  async function poll() {
    await fetchState()
    if (selectedConnectionId.value) {
      await fetchConnectionDetail(selectedConnectionId.value)
    }
  }

  onMounted(() => {
    poll()
    timer = setInterval(poll, pollInterval)
  })

  onUnmounted(() => {
    if (timer) clearInterval(timer)
  })

  return {
    state,
    connectionDetail,
    selectedConnectionId,
    error,
    selectConnection,
    fetchCollectionRecords
  }
}
