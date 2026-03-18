<template>
  <div class="app">
    <div class="top-bar">
      <div class="top-bar-left">
        <span class="logo">mesh <span>devtools</span></span>
      </div>
      <div class="top-bar-right">
        <span class="pulse" :class="{ disconnected: !!error }"></span>
        <span class="instance-id" v-if="state">instance {{ state.instanceId?.slice(0, 8) }}</span>
      </div>
    </div>

    <div class="tab-bar">
      <div
        v-for="tab in tabs"
        :key="tab.id"
        class="tab"
        :class="{ active: activeTab === tab.id }"
        @click="activeTab = tab.id"
      >
        {{ tab.label }}<span class="count" v-if="tab.count !== undefined">{{ tab.count }}</span>
      </div>
    </div>

    <div class="main">
      <div class="sidebar">
        <ConnectionPicker
          :connections="state?.connections || []"
          :selected-id="selectedConnectionId"
          @select="selectConnection"
        />
        <div class="sidebar-section" v-if="state?.exposed">
          <div class="sidebar-header" style="cursor: pointer; user-select: none;" @click="showExposed = !showExposed">
            <span>registered</span>
            <span style="float: right; font-size: 9px;">{{ showExposed ? '−' : '+' }}</span>
          </div>
          <template v-if="showExposed">
            <div
              v-for="(patterns, type) in nonEmptyExposed"
              :key="type"
              class="exposed-row"
            >
              <span class="exposed-label">{{ formatExposedLabel(type) }}</span>
              <span class="tag" v-for="p in patterns" :key="p">{{ p }}</span>
            </div>
          </template>
        </div>
      </div>

      <div class="content">
        <RoomsView
          v-if="activeTab === 'rooms'"
          :rooms="filteredRooms"
          @navigate="navigateToConnection"
        />
        <ChannelsView
          v-if="activeTab === 'channels'"
          :channels="filteredChannels"
          @navigate="navigateToConnection"
        />
        <CollectionsView
          v-if="activeTab === 'collections'"
          :collections="filteredCollections"
          :fetch-records="fetchCollectionRecords"
          @navigate="navigateToConnection"
        />
        <RecordsView
          v-if="activeTab === 'records'"
          :records="filteredRecords"
          @navigate="navigateToConnection"
        />
        <MetadataView
          v-if="activeTab === 'metadata'"
          :detail="connectionDetail"
          :connections="state?.connections || []"
        />
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed } from 'vue'
import { useApi } from './composables/useApi.js'
import ConnectionPicker from './components/ConnectionPicker.vue'
import RoomsView from './views/RoomsView.vue'
import ChannelsView from './views/ChannelsView.vue'
import CollectionsView from './views/CollectionsView.vue'
import RecordsView from './views/RecordsView.vue'
import MetadataView from './views/MetadataView.vue'

const activeTab = ref('rooms')
const showExposed = ref(true)

const exposedLabels = {
  channels: 'channels',
  records: 'records',
  writableRecords: 'writable',
  collections: 'collections',
  presence: 'presence',
  commands: 'commands'
}

function formatExposedLabel(key) {
  return exposedLabels[key] || key
}

function navigateToConnection(connId) {
  selectConnection(connId)
  activeTab.value = 'metadata'
}
const {
  state,
  connectionDetail,
  selectedConnectionId,
  error,
  selectConnection,
  fetchCollectionRecords
} = useApi()

const filteredRooms = computed(() => {
  if (!state.value?.rooms) return []
  if (!selectedConnectionId.value) return state.value.rooms
  return state.value.rooms.filter(r => r.members.includes(selectedConnectionId.value))
})

const filteredChannels = computed(() => {
  if (!state.value?.channels) return {}
  if (!selectedConnectionId.value) return state.value.channels
  const out = {}
  for (const [ch, subs] of Object.entries(state.value.channels)) {
    if (subs.includes(selectedConnectionId.value)) out[ch] = subs
  }
  return out
})

const filteredCollections = computed(() => {
  if (!state.value?.collections) return {}
  if (!selectedConnectionId.value) return state.value.collections
  const out = {}
  for (const [id, info] of Object.entries(state.value.collections)) {
    if (info.subscribers[selectedConnectionId.value]) out[id] = info
  }
  return out
})

const filteredRecords = computed(() => {
  if (!state.value?.records) return {}
  if (!selectedConnectionId.value) return state.value.records
  const out = {}
  for (const [id, info] of Object.entries(state.value.records)) {
    if (info.subscribers[selectedConnectionId.value]) out[id] = info
  }
  return out
})

const nonEmptyExposed = computed(() => {
  if (!state.value?.exposed) return {}
  const out = {}
  for (const [k, v] of Object.entries(state.value.exposed)) {
    if (v.length) out[k] = v
  }
  return out
})

const tabs = computed(() => [
  { id: 'rooms', label: 'rooms', count: filteredRooms.value.length },
  { id: 'channels', label: 'channels', count: Object.keys(filteredChannels.value).length },
  { id: 'collections', label: 'collections', count: Object.keys(filteredCollections.value).length },
  { id: 'records', label: 'records', count: Object.keys(filteredRecords.value).length },
  { id: 'metadata', label: 'metadata' }
])
</script>
