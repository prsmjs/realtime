<p align="center">
  <img src=".github/logo.svg" width="80" height="80" alt="realtime logo">
</p>

<h1 align="center">@prsm/realtime</h1>

<p align="center">
  <a href="https://github.com/prsmjs/realtime/actions/workflows/test.yml"><img src="https://github.com/prsmjs/realtime/actions/workflows/test.yml/badge.svg" alt="test"></a>
  <a href="https://www.npmjs.com/package/@prsm/realtime"><img src="https://img.shields.io/npm/v/@prsm/realtime.svg" alt="npm"></a>
</p>

Distributed WebSocket framework backed by Redis. Handles connections, rooms, presence, pub/sub channels, versioned record sync, collections, structured commands, persistence, and automatic reconnection across multiple server instances.

## Install

```
npm install @prsm/realtime
```

## Server

```js
import express from 'express'
import { createServer } from 'node:http'
import { RealtimeServer } from '@prsm/realtime'

const app = express()
const httpServer = createServer(app)

const realtime = new RealtimeServer({
  redis: { host: '127.0.0.1', port: 6379 },
  authenticateConnection: (req) => {
    return { user: 'amara', role: 'admin' }
  },
})

realtime.exposeChannel(/^notifications$/)
realtime.exposeRecord(/^doc:.+$/)
realtime.exposeWritableRecord(/^doc:.+$/)
realtime.exposeCollection(/^inbox$/, () => [{ id: 'msg:1' }, { id: 'msg:2' }])
realtime.trackPresence(/^room:.+$/)

realtime.exposeCommand('echo', async (ctx) => ({ echoed: ctx.payload }))

await realtime.attach(httpServer, { port: 3000 })

await realtime.writeChannel('notifications', { text: 'system online' })
await realtime.writeRecord('doc:welcome', { title: 'Welcome' })
```

A single Redis instance coordinates connections across any number of server instances. Connections, room membership, presence, records, and collections are all visible cluster-wide.

## Client

```js
import { RealtimeClient } from '@prsm/realtime/client'

const client = new RealtimeClient('ws://localhost:3000')
await client.connect()

await client.joinRoom('lobby')

await client.subscribeRecord('doc:welcome', (update) => {
  console.log('record updated:', update.full ?? update.value)
})

await client.subscribeChannel('notifications', (message) => {
  console.log('notification:', message)
})

await client.publishPresenceState('lobby', { state: { status: 'online' } })

const { echoed } = await client.command('echo', { hello: 'world' })

client.close()
```

The client handles automatic reconnection with backoff, queued commands while disconnected, and re-subscription on reconnect.

## Vue layer

`@prsm/realtime/vue` ships composables and renderless components that wrap the imperative client with reactive state and automatic lifecycle (subscribe on mount, unsubscribe on unmount, switch subscription when reactive keys change).

### Setup

Create a `RealtimeClient` once, connect it, and make it available to descendant components. The recommended pattern is to do this at the root of the app:

```vue
<!-- App.vue -->
<script setup>
import { RealtimeClient } from '@prsm/realtime/client'
import { provideRealtime } from '@prsm/realtime/vue'

const client = new RealtimeClient('ws://localhost:3000')
await client.connect()

provideRealtime(client)
</script>

<template>
  <router-view />
</template>
```

`provideRealtime(client)` is a one-line helper that calls Vue's `provide()` with the right injection key. Every composable below this component automatically picks up the client via `inject()` - you don't have to thread `client` through props or pass it to each composable.

### Using composables

Inside any component descended from `provideRealtime(client)`:

```vue
<script setup>
import { useRoom, useRecord, useChannel, useCollection, usePresence } from '@prsm/realtime/vue'

// auto-joins the room on mount, leaves on unmount
const { members, presence } = useRoom('lobby')

// reactive value; updates flow in from the server; write() pushes back
const { value: doc, write } = useRecord('doc:welcome')

// bounded message log; new messages append; oldest drop after 50
const { messages } = useChannel('notifications', { max: 50 })

// resolves the collection's record IDs and keeps an items list in sync
const { items } = useCollection('inbox')

// `me` is a ref<state> that publishes to the server on change;
// `others` is the live map of other connections' states
const { me, others } = usePresence('lobby', { initial: { status: 'online' } })
</script>

<template>
  <p>{{ members.length }} in the room</p>
  <input v-model="me.status" placeholder="status..." />
  <pre>{{ doc }}</pre>
</template>
```

### Passing the client explicitly

If you can't use the provide tree (tests, isolated components, a second connection), pass the client directly to any composable:

```js
useRoom('lobby', { client })
useRecord('doc:1', { client })
```

The provide pattern is just sugar over this - pick whichever fits.

All composables mount cleanly: subscribing on `onMounted`, unsubscribing on `onBeforeUnmount`. Switching the reactive key (e.g. `useRoom(activeRoom)` where `activeRoom` is a `ref`) tears down the previous subscription and starts a new one automatically.

### Renderless components

For the cases where you want the side effect to live in the template:

```vue
<RealtimeRoom name="lobby" v-slot="{ members }">
  {{ members.length }} online
</RealtimeRoom>

<RealtimeRecord id="doc:welcome" v-slot="{ value, write }">
  <input :value="value?.title" @input="write({ title: $event.target.value })" />
</RealtimeRecord>

<RealtimePresence room="lobby" :state="{ status, cursor }" />
```

### Connection state

`useConnection` exposes the client's connection as reactive state, and `RealtimeStatus` is its renderless wrapper. These observe an existing client - they do not open or manage the connection. The `RealtimeClient` connects on its own (and reconnects on its own); you still create and connect it as shown in [Setup](#setup). Use these only when you want to react to connection state in the UI.

```vue
<script setup>
import { useConnection, useConnectionMetadata } from '@prsm/realtime/vue'

const { status, isOnline, isReconnecting, latency, hasConnected, isStable } = useConnection()

// local source of truth for this connection's metadata; set() writes through
// to the server and the value is re-pushed automatically after a reconnect
const { metadata, set } = useConnectionMetadata({ initial: { name: 'ada' } })
</script>
```

`status` is one of `'online'`, `'connecting'`, `'reconnecting'`, `'offline'`. `hasConnected` becomes true after the first successful connect and stays true. `isStable` tracks `isOnline` but honors a grace window: when the connection drops it stays true for `grace` milliseconds (default `0`), and a reconnect inside that window keeps it true so dependent UI never unmounts on a brief blip.

`RealtimeStatus` gates rendering on `isStable` through named slots, with `grace` as a prop. It reports connection state, it does not open the connection:

```vue
<RealtimeStatus :grace="2000">
  <template #online="{ latency }">
    <ChatRoom />
  </template>
  <template #reconnecting>
    <p>reconnecting...</p>
  </template>
  <template #offline>
    <p>offline</p>
  </template>
</RealtimeStatus>
```

Because the subscription composables queue commands while offline and replay them on reconnect, you don't need to gate them to keep subscriptions working - gate only when you genuinely want the children unmounted.

`vue` is an optional peer dependency. The `/vue` subpath only loads if you import from it.

## Concepts

### Rooms

Named groupings of connections. Used to scope presence and broadcasts.

```js
await client.joinRoom('lobby')
await server.broadcastRoom('lobby', 'announcement', { text: 'welcome' })
await client.leaveRoom('lobby')
```

### Channels

Server-to-client pub/sub. Multiple subscribers, fanned out across instances via Redis.

```js
server.exposeChannel(/^chat:.+$/)
await server.writeChannel('chat:general', { author: 'amara', text: 'hi' })

await client.subscribeChannel('chat:general', (msg) => { /* ... */ })
```

### Records

Versioned shared documents. Subscribers can choose `full` mode (every change ships the whole document) or `patch` mode (server diffs and ships JSON Patches).

```js
server.exposeRecord(/^doc:.+$/)
server.exposeWritableRecord(/^doc:.+$/)

await server.writeRecord('doc:42', { title: 'Hello', body: '...' })

await client.subscribeRecord('doc:42', (update) => {
  console.log(update.full ?? update.patch)
}, { mode: 'patch' })

await client.writeRecord('doc:42', { title: 'Hello', body: '... updated' })
```

### Collections

Indexes over records, resolved per-connection at subscribe time.

```js
server.exposeRecord(/^msg:.+$/)
server.exposeCollection(/^inbox$/, (connection) => [
  { id: 'msg:1' },
  { id: 'msg:2' },
])

await client.subscribeCollection('inbox', {
  onDiff: ({ added, removed, changed }) => { /* ... */ },
})
```

### Presence

Per-room state broadcast to other members of the same room.

```js
server.trackPresence(/^room:.+$/)

await client.joinRoom('room:design')
await client.publishPresenceState('room:design', { state: { cursor: { x: 100, y: 200 } } })

await client.subscribePresence('room:design', (update) => {
  // update.states is the full snapshot when first received
  // subsequent updates carry { connectionId, state } or { connectionId, removed }
})
```

### Commands

Structured RPC. The server exposes named commands; the client invokes them and receives a response.

```js
server.exposeCommand('order:create', async (ctx) => {
  const { user } = ctx.connection.authData
  const id = await db.createOrder(user, ctx.payload)
  return { id }
})

const { id } = await client.command('order:create', { items: [...] })
```

### Persistence

Optional adapters keep record state durable across server restarts.

```js
import { createSqliteAdapter } from '@prsm/realtime/sqlite'
import { createPostgresAdapter } from '@prsm/realtime/postgres'

new RealtimeServer({
  redis: { /* ... */ },
  persistence: createPostgresAdapter({ connectionString: 'postgres://...' }),
})
```

### Authentication

```js
new RealtimeServer({
  authenticateConnection: async (req) => {
    const url = new URL(req.url, 'http://x')
    const token = url.searchParams.get('token')
    const user = await verifyToken(token)
    if (!user) throw new Error('unauthorized')
    return { userId: user.id, role: user.role }
  },
})

// expose guards:
realtime.exposeChannel(/^chat:.+$/, (channel, connection) => {
  return connection.authData.role === 'member'
})
```

### Transactions

Commit related record changes together. For example, reserve a seat only when one remains:

```js
server.exposeCommand('reserve', async ({ payload: { eventId } }) => {
  const eventKey = `event:${eventId}`
  const bookingKey = `booking:${crypto.randomUUID()}`
  const { result } = await server.transaction(async tx => {
    const event = await tx.getRecord(eventKey)
    if (!event || event.seats < 1) throw new Error('Sold out')
    tx.writeRecord(eventKey, { ...event, seats: event.seats - 1 })
    tx.writeRecord(bookingKey, { eventId })
    return { bookingId: bookingKey }
  }, { records: [eventKey, bookingKey] })
  return result
})

// Client
const { bookingId } = await client.command('reserve', { eventId: 'concert' })
```

`server.transaction(fn, { records })` locks every listed record before calling `fn`. Every read, write, and deletion must use the supplied `tx` and refer to a listed record. Disjoint record sets can proceed concurrently. Omit `records` to exclude all other record writers while the callback runs. Ordinary record writes and deletions use the same locks across server instances.

The callback runs once. A thrown error discards its staged changes; external effects such as emails or payments cannot be rolled back. Nested transactions and ordinary record writes inside the callback are rejected. Locks renew while held, expire after 10 seconds without renewal, and are checked at commit. Acquisition waits up to 5 seconds before rejecting.

`tx.getRecord(id)` returns a detached value reflecting staged changes. `tx.writeRecord(id, value, { strategy })` supports `replace`, `merge`, and `deepMerge`. The last staged operation for a record wins, with merges applied to its committed value. The context closes when the callback finishes. The result is `{ id, result, changes }`, where `result` is the callback's return value and `changes` contains changed records with their versions.

For predetermined client edits, `client.transaction(operations)` batches writes and deletions in one request:

```js
await client.transaction([
  { op: 'write', recordId: 'profile:42', value: { name: 'Sam' }, options: { strategy: 'merge' } },
  { op: 'write', recordId: 'preferences:42', value: { theme: 'dark' } },
  { op: 'delete', recordId: 'draft:42' },
])
```

Each record may appear once in a client batch and must be writable by that connection. Invalid operations reject the batch without changes. The response is `{ id, results }`, with an operation, record ID, success flag, and version for each entry. Unchanged writes and missing deletions succeed without changing versions.

Atomicity applies to Redis record storage, not subscriber delivery or persistence adapters. Subscribers receive separate record updates, and persistence follows its normal buffering rules. Notification failures are reported without undoing a committed transaction. Run the same package version on all writers; direct Redis writes and older servers do not participate in these locks. A lost connection during commit can leave its outcome unknown, so do not blindly retry callbacks with external effects.

### Tracing

Pass a `@prsm/trace` tracer to the server and every command, record write, and channel publish becomes a span in the active trace.

```js
import { createTracer } from '@prsm/trace'

const tracer = createTracer({ service: 'realtime-api' })
new RealtimeServer({ redis: { /* ... */ }, tracer })
```

## Dev

```
make up        # start Redis and Postgres
make test      # run tests
make down      # stop containers
```

Redis must be running on localhost:6379 for tests. Postgres is only needed for persistence adapter tests.
