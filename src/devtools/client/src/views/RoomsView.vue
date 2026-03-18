<template>
  <div v-if="!rooms.length" class="empty">no rooms</div>
  <template v-else>
    <div class="view-hint">active rooms, their members, and each member's presence state</div>
    <div v-for="room in rooms" :key="room.name" class="card">
      <div class="card-header">
        <span class="name">{{ room.name }}</span>
        <span class="badge accent">{{ room.members.length }} {{ room.members.length === 1 ? 'member' : 'members' }}</span>
      </div>
      <div v-for="memberId in room.members" :key="memberId" class="member-row">
        <span class="member-id conn-link" :title="memberId" @click="$emit('navigate', memberId)">{{ memberId.slice(0, 8) }}</span>
        <span class="member-presence" v-if="room.presence[memberId]">
          {{ formatPresence(room.presence[memberId]) }}
        </span>
        <span class="no-presence" v-else>no presence</span>
      </div>
    </div>
  </template>
</template>

<script setup>
defineProps({
  rooms: { type: Array, default: () => [] }
})

defineEmits(['navigate'])

function formatPresence(state) {
  if (typeof state === 'string') return state
  if (typeof state === 'object' && state !== null) {
    const keys = Object.keys(state)
    if (keys.length <= 3) {
      return keys.map(k => `${k}: ${JSON.stringify(state[k])}`).join(', ')
    }
    return `{${keys.length} fields}`
  }
  return String(state)
}
</script>
