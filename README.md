<p align="center">
  <img src=".github/logo.svg" width="80" height="80" alt="realtime logo">
</p>

<h1 align="center">@prsm/realtime</h1>

Distributed WebSocket framework with Redis-backed rooms, records, presence, channels, collections, and persistence.

## Installation

```bash
npm install @prsm/realtime
```

Optional persistence adapters:

```bash
npm install sqlite3
npm install pg
```

## Quick Start

```js
import { RealtimeServer } from '@prsm/realtime'

const server = new RealtimeServer({
  redis: { host: '127.0.0.1', port: 6379 },
})

server.exposeCommand('echo', (ctx) => ctx.payload)

server.onError((err) => console.error(err))

await server.listen(8080)
```

Connect from a client:

```js
import { RealtimeClient } from '@prsm/realtime/client'

const client = new RealtimeClient('ws://localhost:8080')
await client.connect()

const result = await client.command('echo', { hello: 'world' })
```

## Subpath Exports

```js
import { RealtimeServer } from '@prsm/realtime'
import { RealtimeClient } from '@prsm/realtime/client'
import { createSqliteAdapter } from '@prsm/realtime/sqlite'
import { createPostgresAdapter } from '@prsm/realtime/postgres'
import { createDevtools } from '@prsm/realtime/devtools'
```

## Commands

Define request/response handlers on the server. Clients call them by name.

```js
server.exposeCommand('profile:update', async (ctx) => {
  const meta = await ctx.getMetadata()
  await ctx.setMetadata({ lastSeenAt: Date.now() }, { strategy: 'merge' })
  return { ok: true }
})
```

### Middleware

Global middleware runs on all commands. Per-command middleware runs after global.

```js
server.useMiddleware(async (ctx) => {
  const meta = await ctx.getMetadata()
  if (!meta?.userId) throw Object.assign(new Error('Unauthorized'), { code: 401 })
})

server.exposeCommand('admin:reset', handler, [adminOnlyMiddleware])
```

## Records

Versioned JSON blobs stored in Redis. Clients subscribe and receive updates as full snapshots or JSON Patch diffs (RFC 6902).

```js
server.exposeRecord(/^profile:/)
server.exposeWritableRecord(/^profile:/)

await server.writeRecord('profile:123', { name: 'Ada' })
await server.writeRecord('profile:123', { theme: 'dark' }, { strategy: 'deepMerge' })
```

Client side:

```js
import { RealtimeClient, applyPatch } from '@prsm/realtime/client'

let state

await client.subscribeRecord('profile:123', ({ full, patch, version }) => {
  if (full !== undefined) state = full
  if (patch) state = applyPatch(state, patch, true).newDocument
}, { mode: 'patch' })
```

The client detects version gaps and auto-resubscribes to repair state.

## Channels

Pub/sub streams with optional history. Messages are auto-stringified.

```js
server.exposeChannel(/^chat:/)
await server.writeChannel('chat:lobby', { text: 'hello' }, 50)
```

```js
const { history } = await client.subscribeChannel('chat:lobby', (msg) => {
  console.log(msg)
}, { historyLimit: 50 })
```

## Rooms

Membership sets in Redis. Use them to target broadcasts and drive presence.

```js
await client.joinRoom('lobby', (update) => {
  console.log(update.present)
})
```

Server side:

```js
await server.addToRoom('lobby', connection)
await server.broadcastRoom('lobby', 'notice', { text: 'hello' })
```

## Presence

TTL-driven online/offline tracking with ephemeral state (typing indicators, cursors).

```js
server.trackPresence(/^room:/, { ttl: 30_000 })
```

```js
await client.joinRoom('room:lobby', (update) => {
  console.log(update.present, update.states)
})

await client.publishPresenceState('room:lobby', {
  state: { typing: true },
  expireAfter: 2000,
})
```

## Collections

Server-resolved sets of records with membership diffing.

```js
server.exposeCollection(/^users:online$/, async () => {
  return server.listRecordsMatching('user:*', {
    sort: (a, b) => a.name.localeCompare(b.name),
    slice: { start: 0, count: 50 },
  })
})
```

```js
const { records } = await client.subscribeCollection('users:online', {
  onDiff: ({ added, removed, changed }) => {
    console.log({ added, removed, changed })
  },
})
```

## Authentication

Validate during WebSocket upgrade. The return value becomes connection metadata.

```js
const server = new RealtimeServer({
  redis: { host: '127.0.0.1', port: 6379 },
  authenticateConnection: async (req) => {
    const token = req.headers['authorization']
    if (!token) return null
    return { userId: '123' }
  },
})
```

## Cross-Instance Messaging

Multiple server instances share state via Redis. Send to any connection regardless of which instance it's on.

```js
await server.sendTo(connectionId, 'job:complete', result)
await server.broadcastRoom('dashboard', 'update', data)
await server.broadcastExclude('notice', { text: 'maintenance' }, connection)
```

## Persistence

Opt-in, pattern-based. Pass an adapter to the server, then enable per channel or record pattern.

```js
import { RealtimeServer } from '@prsm/realtime'
import { createSqliteAdapter } from '@prsm/realtime/sqlite'

const server = new RealtimeServer({
  redis: { host: '127.0.0.1', port: 6379 },
  persistence: createSqliteAdapter({ filename: './data/realtime.db' }),
})

server.enableChannelPersistence(/^chat:/, { historyLimit: 1000 })

server.enableRecordPersistence({
  pattern: /^doc:/,
  adapter: { restorePattern: 'doc:%' },
})
```

## Client Resilience

The client handles reconnection, resubscription, and browser tab visibility automatically.

```js
const client = new RealtimeClient('ws://localhost:8080', {
  shouldReconnect: true,
  reconnectInterval: 2000,
  maxReconnectAttempts: Infinity,
})

client.on('reconnect', () => {
  // all subscriptions and room memberships are automatically restored
})

client.on('republish', async () => {
  // tab became visible, re-send ephemeral state
  await client.publishPresenceState('lobby', { state: { online: true }, silent: true })
})
```

## Devtools

State inspector for development. Mounts as Express middleware.

```js
import express from 'express'
import http from 'node:http'
import { RealtimeServer } from '@prsm/realtime'
import { createDevtools } from '@prsm/realtime/devtools'

const app = express()
const httpServer = http.createServer(app)

const server = new RealtimeServer({ redis: { host: '127.0.0.1', port: 6379 } })

app.use('/devtools', createDevtools(server))

await server.attach(httpServer, { port: 3000 })
```

## Task Queue Integration with [queue](https://github.com/nvms/queue)

Queue events are local-only. Use realtime to push results to connected clients.

```js
import Queue from '@prsm/queue'
import { RealtimeServer } from '@prsm/realtime'

const server = new RealtimeServer({ redis: { host: 'localhost', port: 6379 } })
const queue = new Queue({ concurrency: 5, groups: { concurrency: 1 } })

queue.process(async (payload) => {
  return await generateReport(payload)
})

queue.on('complete', ({ task, result }) => {
  server.sendTo(task.payload.connectionId, 'job:complete', result)
})

server.exposeCommand('generate-report', async (ctx) => {
  const taskId = await queue.group(ctx.connection.id).push({
    connectionId: ctx.connection.id,
    ...ctx.payload,
  })
  return { queued: true, taskId }
})

await queue.ready()
await server.listen(8080)
```

## Scheduled Broadcasting with [cron](https://github.com/nvms/cron)

```js
import { Cron } from '@prsm/cron'
import { RealtimeServer } from '@prsm/realtime'

const server = new RealtimeServer({ redis: { host: 'localhost', port: 6379 } })
const cron = new Cron()

cron.add('leaderboard', '*/5 * * * *', async () => {
  return await computeLeaderboard()
})

cron.on('fire', ({ name, result }) => {
  server.broadcastRoom('dashboard', `cron:${name}`, result)
})

await server.listen(8080)
await cron.start()
```

## Horizontal Scaling

All connection routing, room membership, record state, and presence lives in Redis. Deploy as many server instances as needed - they coordinate automatically via Redis pub/sub. No leader election, no sticky sessions.

## Cleanup

```js
await server.close()
await client.close()
```

`server.enableGracefulShutdown()` registers SIGTERM/SIGINT handlers that call `close()` automatically.

## Development

```bash
make up
make test
make down
```

## License

MIT
