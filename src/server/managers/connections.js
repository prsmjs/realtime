import { deepMerge, isObject } from "../../shared/index.js"

const CONNECTIONS_HASH_KEY = "mesh:connections"
const CONNECTIONS_META_HASH_KEY = "mesh:connection-meta"
const INSTANCE_CONNECTIONS_KEY_PREFIX = "mesh:connections:"

export class ConnectionManager {
  constructor({ redis, instanceId, roomManager }) {
    this.redis = redis
    this.instanceId = instanceId
    this.roomManager = roomManager
    this.localConnections = {}
  }

  getLocalConnections() {
    return Object.values(this.localConnections)
  }

  getLocalConnection(id) {
    return this.localConnections[id] ?? null
  }

  async registerConnection(connection) {
    this.localConnections[connection.id] = connection
    const pipeline = this.redis.pipeline()
    pipeline.hset(CONNECTIONS_HASH_KEY, connection.id, this.instanceId)
    pipeline.sadd(`${INSTANCE_CONNECTIONS_KEY_PREFIX}${this.instanceId}`, connection.id)
    await pipeline.exec()
  }

  async deregisterConnection(connection) {
    const instanceId = await this.redis.hget(CONNECTIONS_HASH_KEY, connection.id)
    if (!instanceId) return
    const pipeline = this.redis.pipeline()
    pipeline.hdel(CONNECTIONS_HASH_KEY, connection.id)
    pipeline.srem(`${INSTANCE_CONNECTIONS_KEY_PREFIX}${instanceId}`, connection.id)
    await pipeline.exec()
  }

  async getInstanceIdsForConnections(connectionIds) {
    if (connectionIds.length === 0) return {}
    const instanceIds = await this.redis.hmget(CONNECTIONS_HASH_KEY, ...connectionIds)
    const result = {}
    connectionIds.forEach((id, index) => { result[id] = instanceIds[index] ?? null })
    return result
  }

  async getAllConnectionIds() {
    return this.redis.hkeys(CONNECTIONS_HASH_KEY)
  }

  async getLocalConnectionIds() {
    return this.redis.smembers(`${INSTANCE_CONNECTIONS_KEY_PREFIX}${this.instanceId}`)
  }

  async setMetadata(connection, metadata, options) {
    let finalMetadata
    const strategy = options?.strategy || "replace"
    if (strategy === "replace") {
      finalMetadata = metadata
    } else {
      const existingMetadata = await this.getMetadata(connection)
      if (strategy === "merge") {
        finalMetadata = isObject(existingMetadata) && isObject(metadata)
          ? { ...existingMetadata, ...metadata }
          : metadata
      } else if (strategy === "deepMerge") {
        finalMetadata = isObject(existingMetadata) && isObject(metadata)
          ? deepMerge(existingMetadata, metadata)
          : metadata
      }
    }
    const id = typeof connection === "string" ? connection : connection.id
    await this.redis.hset(CONNECTIONS_META_HASH_KEY, id, JSON.stringify(finalMetadata))
  }

  async getMetadata(connection) {
    const id = typeof connection === "string" ? connection : connection.id
    const metadata = await this.redis.hget(CONNECTIONS_META_HASH_KEY, id)
    return metadata ? JSON.parse(metadata) : null
  }

  async getAllMetadata() {
    const connectionIds = await this.getAllConnectionIds()
    return this._getMetadataForConnectionIds(connectionIds)
  }

  async getAllMetadataForRoom(roomName) {
    const connectionIds = await this.roomManager.getRoomConnectionIds(roomName)
    return this._getMetadataForConnectionIds(connectionIds)
  }

  async _getMetadataForConnectionIds(connectionIds) {
    if (connectionIds.length === 0) return []
    const values = await this.redis.hmget(CONNECTIONS_META_HASH_KEY, ...connectionIds)
    return connectionIds.map((id, index) => {
      try {
        const raw = values[index]
        return { id, metadata: raw ? JSON.parse(raw) : null }
      } catch {
        return { id, metadata: null }
      }
    })
  }

  async cleanupConnection(connection) {
    delete this.localConnections[connection.id]
    await this.deregisterConnection(connection)
    await this.redis.hdel(CONNECTIONS_META_HASH_KEY, connection.id)
  }
}
