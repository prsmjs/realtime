<template>
  <div v-if="detail">
    <div class="section">
      <div class="section-title">connection</div>
      <div class="card">
        <div class="card-body">
          <div class="kv-row">
            <span class="kv-key">id</span>
            <span class="kv-value">{{ detail.id }}</span>
          </div>
          <div class="kv-row">
            <span class="kv-key">local</span>
            <span class="kv-value" :style="{ color: detail.local ? 'var(--accent)' : 'var(--text-muted)' }">{{ detail.local }}</span>
          </div>
          <div class="kv-row">
            <span class="kv-key">latency</span>
            <span class="kv-value">{{ detail.latency !== null ? detail.latency + 'ms' : '-' }}</span>
          </div>
          <div class="kv-row">
            <span class="kv-key">alive</span>
            <span class="kv-value" :style="{ color: detail.alive ? 'var(--accent)' : 'var(--syn-boolean)' }">{{ detail.alive }}</span>
          </div>
          <div class="kv-row" v-if="detail.remoteAddress">
            <span class="kv-key">address</span>
            <span class="kv-value">{{ detail.remoteAddress }}</span>
          </div>
        </div>
      </div>
    </div>

    <div class="section">
      <div class="section-title">metadata</div>
      <div class="card">
        <div class="card-body">
          <JsonView :data="detail.metadata" />
        </div>
      </div>
    </div>

    <div class="section" v-if="detail.rooms?.length">
      <div class="section-title">rooms ({{ detail.rooms.length }})</div>
      <div class="pattern-list">
        <span class="tag accent" v-for="room in detail.rooms" :key="room">{{ room }}</span>
      </div>
    </div>

    <div class="section" v-if="detail.channels?.length">
      <div class="section-title">channels ({{ detail.channels.length }})</div>
      <div class="pattern-list">
        <span class="tag accent" v-for="ch in detail.channels" :key="ch">{{ ch }}</span>
      </div>
    </div>

    <div class="section" v-if="detail.collections?.length">
      <div class="section-title">collections ({{ detail.collections.length }})</div>
      <div class="pattern-list">
        <span class="tag accent" v-for="col in detail.collections" :key="col.id">{{ col.id }} v{{ col.version }}</span>
      </div>
    </div>

    <div class="section" v-if="detail.records?.length">
      <div class="section-title">record subscriptions ({{ detail.records.length }})</div>
      <div v-for="rec in detail.records" :key="rec.id" class="kv-row">
        <span class="kv-key">{{ rec.id }}</span>
        <span class="kv-value">{{ rec.mode }}</span>
      </div>
    </div>

    <div class="section" v-if="detail.presence && Object.keys(detail.presence).length">
      <div class="section-title">presence state</div>
      <div v-for="(pstate, room) in detail.presence" :key="room" class="card">
        <div class="card-header">
          <span class="name">{{ room }}</span>
        </div>
        <div class="card-body">
          <JsonView :data="pstate" />
        </div>
      </div>
    </div>
  </div>

  <div v-else-if="connections.length">
    <div class="section-title" style="margin-bottom: 12px;">all connections</div>
    <div v-for="conn in connections" :key="conn.id" class="card">
      <div class="card-header">
        <span class="name">{{ conn.metadata?.name || conn.metadata?.username || conn.id.slice(0, 8) }}</span>
        <span class="meta" style="font-size: 10px;">
          <span v-if="conn.latency !== null" style="margin-right: 8px;">{{ conn.latency }}ms</span>
          <span :style="{ color: conn.alive ? 'var(--accent)' : 'var(--syn-boolean)' }">{{ conn.alive ? 'alive' : 'dead' }}</span>
        </span>
      </div>
      <div class="card-body" v-if="conn.metadata">
        <JsonView :data="conn.metadata" />
      </div>
    </div>
  </div>

  <div v-else class="empty">no connections</div>
</template>

<script setup>
import JsonView from '../components/JsonView.vue'

defineProps({
  detail: { type: Object, default: null },
  connections: { type: Array, default: () => [] }
})
</script>
