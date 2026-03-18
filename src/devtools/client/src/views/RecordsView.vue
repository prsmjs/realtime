<template>
  <div v-if="!recordEntries.length" class="empty">no record subscriptions</div>
  <template v-else>
    <div class="view-hint">records being watched by at least one connection, and their subscription mode</div>
    <div v-for="[recordId, info] in recordEntries" :key="recordId" class="card">
      <div class="card-header">
        <span class="name">{{ recordId }}</span>
        <span class="badge accent">{{ Object.keys(info.subscribers).length }} {{ Object.keys(info.subscribers).length === 1 ? 'subscriber' : 'subscribers' }}</span>
      </div>
      <div class="card-body">
        <div v-for="(mode, connId) in info.subscribers" :key="connId" class="kv-row">
          <span class="kv-key conn-link" :title="connId" @click="$emit('navigate', connId)">{{ connId.slice(0, 8) }}</span>
          <span class="tag" :class="mode === 'full' ? 'accent' : ''">{{ mode }}</span>
        </div>
      </div>
    </div>
  </template>
</template>

<script setup>
import { computed } from 'vue'

const props = defineProps({
  records: { type: Object, default: () => ({}) }
})

defineEmits(['navigate'])

const recordEntries = computed(() => Object.entries(props.records))
</script>
