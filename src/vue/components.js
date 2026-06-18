import { defineComponent, h, toRef, watch } from 'vue'
import { useRoom } from './useRoom.js'
import { usePresence } from './usePresence.js'
import { useRecord } from './useRecord.js'
import { useConnection } from './useConnection.js'
import { injectRealtime } from './provide.js'

/**
 * Renderless component wrapping `useRoom`. Joins the room on mount, leaves on
 * unmount, and exposes the room state to its default slot.
 *
 * Props:
 * - `name` (String, required) - The room to join. Changing it switches rooms reactively.
 * - `client` (Object, default null) - An explicit RealtimeClient. Falls back to the provided client when null.
 *
 * The default slot receives the `useRoom` return ({ members, presence, joined, error }).
 */
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

/**
 * Renderless component wrapping `usePresence`. Tracks presence in a room and
 * publishes the local state, exposing both to its default slot.
 *
 * Props:
 * - `room` (String, required) - The room whose presence to track. Changing it switches rooms reactively.
 * - `state` (Object|null, default null) - The local presence state to publish. Updating it (including deep changes) republishes.
 * - `client` (Object, default null) - An explicit RealtimeClient. Falls back to the provided client when null.
 *
 * The default slot receives the `usePresence` return ({ me, others }).
 */
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

/**
 * Renderless component wrapping `useRecord`. Subscribes to the record and
 * exposes its live value to the default slot.
 *
 * Props:
 * - `id` (String, required) - The record to subscribe to. Changing it follows a different record reactively.
 * - `mode` (String, default 'full') - Update delivery mode, either 'full' (replace on each update) or 'patch' (incremental).
 * - `client` (Object, default null) - An explicit RealtimeClient. Falls back to the provided client when null.
 *
 * The default slot receives the `useRecord` return ({ value, version, ready, error, write }).
 */
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

/**
 * Renderless component wrapping `useConnection`. It only observes connection
 * status; it never opens or reconnects the connection. Named RealtimeStatus
 * (not RealtimeConnection) so it is not mistaken for the thing that opens the
 * connection.
 *
 * Props:
 * - `grace` (Number, default 0) - Grace window in milliseconds. After a drop, the stable state holds for this long so the online slot does not flicker on a brief blip.
 * - `client` (Object, default null) - An explicit RealtimeClient. Falls back to the provided client when null.
 *
 * Slots: `online` (rendered while stable), `reconnecting`, and `offline` are
 * chosen by status; `default` is the fallback. The chosen slot receives the
 * `useConnection` return ({ status, isOnline, isReconnecting, isStable, latency, hasConnected }).
 */
export const RealtimeStatus = defineComponent({
  name: 'RealtimeStatus',
  props: {
    grace: { type: Number, default: 0 },
    client: { type: Object, default: null },
  },
  setup(props, { slots }) {
    const graceRef = toRef(props, 'grace')
    const conn = useConnection({ client: props.client, grace: graceRef })
    return () => {
      const slot = conn.isStable.value
        ? slots.online
        : conn.isReconnecting.value
          ? slots.reconnecting
          : slots.offline
      return (slot ?? slots.default)?.(conn) ?? null
    }
  },
})
