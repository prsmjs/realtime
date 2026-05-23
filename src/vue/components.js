import { defineComponent, h, toRef, watch } from 'vue'
import { useRoom } from './useRoom.js'
import { usePresence } from './usePresence.js'
import { useRecord } from './useRecord.js'
import { injectRealtime } from './provide.js'

export const RealtimeRoom = defineComponent({
  name: 'RealtimeRoom',
  props: {
    name: { type: String, required: true },
    client: { type: Object, default: null },
  },
  setup(props, { slots }) {
    const nameRef = toRef(props, 'name')
    const room = useRoom(nameRef, { client: props.client })
    return () => slots.default?.(room) ?? null
  },
})

export const RealtimePresence = defineComponent({
  name: 'RealtimePresence',
  props: {
    room: { type: String, required: true },
    state: { type: [Object, null], default: null },
    client: { type: Object, default: null },
  },
  setup(props, { slots }) {
    const roomRef = toRef(props, 'room')
    const presence = usePresence(roomRef, { client: props.client, initial: props.state })
    watch(() => props.state, (next) => { presence.me.value = next }, { deep: true })
    return () => slots.default?.(presence) ?? null
  },
})

export const RealtimeRecord = defineComponent({
  name: 'RealtimeRecord',
  props: {
    id: { type: String, required: true },
    mode: { type: String, default: 'full' },
    client: { type: Object, default: null },
  },
  setup(props, { slots }) {
    const idRef = toRef(props, 'id')
    const record = useRecord(idRef, { client: props.client, mode: props.mode })
    return () => slots.default?.(record) ?? null
  },
})
