import express from "express"
import http from "node:http"
import { RealtimeServer } from "../../../src/index.js"
import { RealtimeClient } from "../../../src/client/index.js"
import { createDevtools } from "../index.js"

const PORT = 3399

const app = express()
const httpServer = http.createServer(app)

const mesh = new RealtimeServer({
  redis: { host: "127.0.0.1", port: 6379, db: 15 }
})

mesh.exposeChannel(/^chat:.*/)
mesh.exposeChannel("notifications")
mesh.exposeRecord(/^user:.*/)
mesh.exposeWritableRecord(/^doc:.*/)
mesh.trackPresence(/^room:.*/)

mesh.exposeCollection("users:online", async () => {
  return await mesh.listRecordsMatching("user:*")
})

mesh.exposeCollection("docs:shared", async () => {
  return await mesh.listRecordsMatching("doc:*")
})

mesh.exposeCollection(/^users-by-role:.*/, async (_conn, collectionId) => {
  const role = collectionId.split(":")[1]
  const users = await mesh.listRecordsMatching("user:*")
  return users.filter(u => u.role === role)
})

mesh.exposeCommand("echo", (ctx) => ctx.payload)

app.use("/devtools", createDevtools(mesh))

const redis = mesh.redisManager.redis
await redis.flushdb()

await mesh.attach(httpServer, { port: PORT })

const names = ["alice", "bob", "charlie", "diana", "eve"]
const statuses = ["online", "away", "busy", "idle"]
const rooms = ["room:lobby", "room:general", "room:random"]
const channels = ["chat:general", "chat:random", "notifications"]

const clients = []

for (let i = 0; i < names.length; i++) {
  const client = new RealtimeClient(`ws://localhost:${PORT}`)
  await client.connect()

  await mesh.setConnectionMetadata(client.connectionId, {
    name: names[i],
    role: i === 0 ? "admin" : "member",
    joinedAt: new Date().toISOString()
  })

  const role = i === 0 ? "admin" : "member"
  await mesh.writeRecord(`user:${names[i]}`, {
    id: `user:${names[i]}`,
    name: names[i],
    email: `${names[i]}@example.com`,
    role,
    active: true
  })

  if (i < 3) {
    await mesh.writeRecord(`doc:doc-${i}`, {
      id: `doc:doc-${i}`,
      title: `Document ${i}`,
      content: "lorem ipsum",
      author: names[i]
    })
  }

  const clientRooms = rooms.slice(0, 1 + (i % rooms.length))
  for (const room of clientRooms) {
    await client.joinRoom(room)
    await client.subscribePresence(room, () => {})
  }
  await new Promise(r => setTimeout(r, 100))
  for (const room of clientRooms) {
    await client.publishPresenceState(room, {
      state: {
        status: statuses[i % statuses.length],
        cursor: { x: Math.floor(Math.random() * 800), y: Math.floor(Math.random() * 600) }
      }
    })
  }

  const clientChannels = channels.slice(0, 1 + (i % channels.length))
  for (const ch of clientChannels) {
    await client.subscribeChannel(ch, () => {})
  }

  await client.subscribeRecord(`user:${names[i]}`, () => {})
  if (i < 3) await client.subscribeRecord(`doc:doc-${i}`, () => {})

  clients.push(client)
}

await new Promise(r => setTimeout(r, 300))

for (const client of clients) {
  await client.subscribeCollection("users:online", { onDiff: () => {} })
}

for (const client of clients.slice(0, 3)) {
  await client.subscribeCollection("docs:shared", { onDiff: () => {} })
}

await clients[0].subscribeCollection("users-by-role:admin", { onDiff: () => {} })
await clients[1].subscribeCollection("users-by-role:member", { onDiff: () => {} })
await clients[2].subscribeCollection("users-by-role:admin", { onDiff: () => {} })

setInterval(async () => {
  const i = Math.floor(Math.random() * clients.length)
  const room = rooms[Math.floor(Math.random() * rooms.length)]
  const clientRooms = rooms.slice(0, 1 + (i % rooms.length))
  if (!clientRooms.includes(room)) return

  await clients[i].publishPresenceState(room, {
    state: {
      status: statuses[Math.floor(Math.random() * statuses.length)],
      cursor: { x: Math.floor(Math.random() * 800), y: Math.floor(Math.random() * 600) }
    }
  })
}, 3000)

setInterval(async () => {
  const ch = channels[Math.floor(Math.random() * channels.length)]
  await mesh.writeChannel(ch, {
    from: names[Math.floor(Math.random() * names.length)],
    text: `message at ${new Date().toISOString()}`,
  }, 20)
}, 5000)

console.log(`mesh devtools demo running on http://localhost:${PORT}/devtools`)
console.log(`${names.length} clients connected, ${rooms.length} rooms, ${channels.length} channels`)
console.log(`vite dev server: cd packages/devtools/client && npm run dev`)
