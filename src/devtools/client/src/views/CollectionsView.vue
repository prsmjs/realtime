<template>
  <div v-if="!collectionEntries.length" class="empty">no collection subscriptions</div>
  <template v-else>
    <div class="view-hint">collections with active subscribers - click "records" to see what the resolver returns for that connection</div>
    <div v-for="[collId, info] in collectionEntries" :key="collId" class="card">
      <div class="card-header">
        <span class="name">{{ collId }}</span>
        <span class="badge accent">{{ Object.keys(info.subscribers).length }} {{ Object.keys(info.subscribers).length === 1 ? 'subscriber' : 'subscribers' }}</span>
      </div>
      <div v-for="(sub, connId) in info.subscribers" :key="connId">
        <div class="card-body" style="border-top: 1px solid var(--border-subtle);">
          <div class="kv-row">
            <span class="kv-key conn-link" :title="connId" @click="$emit('navigate', connId)">{{ connId.slice(0, 8) }}</span>
            <span class="kv-value">v{{ sub.version }}</span>
            <span
              class="tag accent"
              style="margin-left: 8px; cursor: pointer;"
              @click="toggleRecords(collId, connId)"
            >{{ loadedRecords[recordKey(collId, connId)] ? 'hide' : 'records' }}</span>
          </div>
        </div>
        <div v-if="loadedRecords[recordKey(collId, connId)]" class="card-body" style="border-top: 1px solid var(--border-subtle); padding-left: 24px;">
          <div class="section-title">resolved records ({{ loadedRecords[recordKey(collId, connId)].recordIds.length }})</div>
          <div v-for="rec in loadedRecords[recordKey(collId, connId)].records" :key="rec.id" style="margin-bottom: 8px;">
            <div style="font-size: 10px; color: var(--text-muted); margin-bottom: 2px;">{{ rec.id }}</div>
            <JsonView :data="rec.data" />
          </div>
          <div v-if="!loadedRecords[recordKey(collId, connId)].records.length" class="empty" style="padding: 8px;">no records</div>
        </div>
      </div>
    </div>
  </template>
</template>

<script setup>
import { computed, reactive } from 'vue'
import JsonView from '../components/JsonView.vue'

const props = defineProps({
  collections: { type: Object, default: () => ({}) },
  fetchRecords: { type: Function, required: true }
})

defineEmits(['navigate'])

const collectionEntries = computed(() => Object.entries(props.collections))
const loadedRecords = reactive({})

function recordKey(collId, connId) {
  return `${collId}::${connId}`
}

async function toggleRecords(collId, connId) {
  const key = recordKey(collId, connId)
  if (loadedRecords[key]) {
    delete loadedRecords[key]
    return
  }
  loadedRecords[key] = await props.fetchRecords(collId, connId)
}
</script>
