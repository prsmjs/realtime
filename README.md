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

const { result } = await client.command('echo', { hello: 'world' })

client.close()
```

The client handles automatic reconnection with backoff, queued commands while disconnected, and re-subscription on reconnect.

## Vue layer

`@prsm/realtime/vue` ships composables and renderless components that wrap the imperative client with reactive state and automatic lifecycle.

```js
// at the root of your app
import { createApp } from 'vue'
import { RealtimeClient } from '@prsm/realtime/client'
import { provideRealtime } from '@prsm/realtime/vue'

const client = new RealtimeClient('ws://localhost:3000')
await client.connect()

const app = createApp(App)
app.provide(/* provide via a parent component or use provideRealtime in setup() */)
```

```vue
<!-- inside any setup() that descends from a provideRealtime() call -->
<script setup>
import { useRoom, useRecord, useChannel, useCollection, usePresence } from '@prsm/realtime/vue'

const { members, presence } = useRoom('lobby')                       // auto-join / auto-leave
const { value: doc, write } = useRecord('doc:welcome')               // reactive record
const { messages } = useChannel('notifications', { max: 50 })        // bounded message history
const { items } = useCollection('inbox')                             // diff-applied list
const { me, others } = usePresence('lobby', { initial: { status: 'online' } })
</script>
```

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

### Provide pattern

```js
// in a top-level component's setup()
import { provideRealtime } from '@prsm/realtime/vue'
import { RealtimeClient } from '@prsm/realtime/client'

const client = new RealtimeClient('ws://localhost:3000')
await client.connect()
provideRealtime(client)
```

Every composable below this provider injects the client automatically. To use a composable outside the provider tree (tests, special cases), pass it explicitly:

```js
useRoom('lobby', { client })
```

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
