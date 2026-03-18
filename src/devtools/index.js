import express from "express"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"
import { existsSync } from "node:fs"

function patternToString(p) {
  if (typeof p === "string") return p
  if (p instanceof RegExp) return p.toString()
  return String(p)
}

export function createDevtools(server) {
  const router = express.Router()
  const __dirname = dirname(fileURLToPath(import.meta.url))
  const distPath = join(__dirname, "client", "dist")

  router.get("/api/state", async (_req, res) => {
    try {
      const connIds = await server.connectionManager.getAllConnectionIds()
      const allMeta = await server.connectionManager._getMetadataForConnectionIds(connIds)
      const localConns = server.connectionManager.getLocalConnections()
      const localMap = {}
      for (const conn of localConns) {
        localMap[conn.id] = conn
      }

      const connections = allMeta.map(({ id, metadata }) => {
        const local = localMap[id]
        return {
          id,
          metadata,
          local: !!local,
          latency: local?.latency?.ms ?? null,
          alive: local?.alive ?? null,
          remoteAddress: local?.remoteAddress ?? null
        }
      })

      const roomNames = await server.roomManager.getAllRooms()
      const rooms = []
      for (const name of roomNames) {
        const members = await server.roomManager.getRoomConnectionIds(name)
        const statesMap = await server.presenceManager.getAllPresenceStates(name)
        const presence = {}
        statesMap.forEach((state, connId) => { presence[connId] = state })
        rooms.push({ name, members, presence })
      }

      const channels = {}
      for (const [channel, subscribers] of Object.entries(server.channelManager.channelSubscriptions)) {
        if (channel.startsWith("mesh:presence:updates:")) continue
        channels[channel] = [...subscribers].map(c => c.id)
      }

      const collections = {}
      server.collectionManager.collectionSubscriptions.forEach((subs, collId) => {
        const subscribers = {}
        subs.forEach((info, connId) => { subscribers[connId] = info })
        collections[collId] = { subscribers }
      })

      const records = {}
      server.recordSubscriptionManager.recordSubscriptions.forEach((subs, recordId) => {
        const subscribers = {}
        subs.forEach((mode, connId) => { subscribers[connId] = mode })
        records[recordId] = { subscribers }
      })

      const exposed = {
        channels: server.channelManager.exposedChannels.map(patternToString),
        records: server.recordSubscriptionManager.exposedRecords.map(patternToString),
        writableRecords: server.recordSubscriptionManager.exposedWritableRecords.map(patternToString),
        collections: server.collectionManager.exposedCollections.map(e => patternToString(e.pattern)),
        presence: server.presenceManager.trackedRooms.map(patternToString),
        commands: server.commandManager.commands
          ? Object.keys(server.commandManager.commands).filter(c => !c.startsWith("mesh/"))
          : []
      }

      res.json({
        instanceId: server.instanceId,
        connections,
        rooms,
        channels,
        collections,
        records,
        exposed
      })
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  })

  router.get("/api/connection/:id", async (req, res) => {
    try {
      const { id } = req.params
      const metadata = await server.connectionManager.getMetadata(id)
      const rooms = await server.roomManager.getRoomsForConnection(id)

      const presence = {}
      for (const room of rooms) {
        const state = await server.presenceManager.getPresenceState(id, room)
        if (state) presence[room] = state
      }

      const channels = []
      for (const [channel, subscribers] of Object.entries(server.channelManager.channelSubscriptions)) {
        if (channel.startsWith("mesh:presence:updates:")) continue
        for (const conn of subscribers) {
          if (conn.id === id) { channels.push(channel); break }
        }
      }

      const collections = []
      server.collectionManager.collectionSubscriptions.forEach((subs, collId) => {
        if (subs.has(id)) collections.push({ id: collId, ...subs.get(id) })
      })

      const records = []
      server.recordSubscriptionManager.recordSubscriptions.forEach((subs, recordId) => {
        if (subs.has(id)) records.push({ id: recordId, mode: subs.get(id) })
      })

      const local = server.connectionManager.getLocalConnection(id)

      res.json({
        id,
        metadata,
        rooms,
        presence,
        channels,
        collections,
        records,
        local: !!local,
        latency: local?.latency?.ms ?? null,
        alive: local?.alive ?? null,
        remoteAddress: local?.remoteAddress ?? null
      })
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  })

  router.get("/api/room/:name", async (req, res) => {
    try {
      const { name } = req.params
      const membersWithMeta = await server.getRoomMembersWithMetadata(name)
      const statesMap = await server.presenceManager.getAllPresenceStates(name)
      const presence = {}
      statesMap.forEach((state, connId) => { presence[connId] = state })
      res.json({ name, members: membersWithMeta, presence })
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  })

  router.get("/api/collection/:id/records", async (req, res) => {
    try {
      const collId = req.params.id
      const connId = req.query.connId
      if (!connId) return res.status(400).json({ error: "connId query param required" })

      const raw = await server.redisManager.redis.get(`mesh:collection:${collId}:${connId}`)
      if (!raw) return res.json({ recordIds: [], records: [] })

      const recordIds = JSON.parse(raw)
      const records = []
      for (const rid of recordIds) {
        const data = await server.recordManager.getRecord(rid)
        records.push({ id: rid, data })
      }
      res.json({ recordIds, records })
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  })

  if (existsSync(distPath)) {
    router.use(express.static(distPath))
    router.get("/{*splat}", (_req, res) => {
      res.sendFile(join(distPath, "index.html"))
    })
  }

  return router
}
