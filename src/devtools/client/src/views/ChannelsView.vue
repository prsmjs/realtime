<template>
  <div v-if="!channelEntries.length" class="empty">no channel subscriptions</div>
  <template v-else>
    <div class="view-hint">channels with active subscribers on this server instance</div>
    <div v-for="[channel, subscribers] in channelEntries" :key="channel" class="card">
      <div class="card-header">
        <span class="name">{{ channel }}</span>
        <span class="badge accent">{{ subscribers.length }} {{ subscribers.length === 1 ? 'subscriber' : 'subscribers' }}</span>
      </div>
      <div v-for="connId in subscribers" :key="connId" class="member-row">
        <span class="member-id conn-link" :title="connId" @click="$emit('navigate', connId)">{{ connId.slice(0, 8) }}</span>
      </div>
    </div>
  </template>
</template>

<script setup>
import { computed } from 'vue'

const props = defineProps({
  channels: { type: Object, default: () => ({}) }
})

defineEmits(['navigate'])

const channelEntries = computed(() => Object.entries(props.channels))
</script>
