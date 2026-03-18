import { deepMerge, isObject, serverLogger } from "../../shared/index.js"

export class RoomManager {
  constructor({ redis }) {
    this.redis = redis
  }

  roomKey(roomName) { return `mesh:room:${roomName}` }
  connectionsRoomKey(connectionId) { return `mesh:connection:${connectionId}:rooms` }
  roomMetadataKey(roomName) { return `mesh:roommeta:${roomName}` }

  async getRoomConnectionIds(roomName) {
    return this.redis.smembers(this.roomKey(roomName))
  }

  async connectionIsInRoom(roomName, connection) {
    const connectionId = typeof connection === "string" ? connection : connection.id
    return !!(await this.redis.sismember(this.roomKey(roomName), connectionId))
  }

  async addToRoom(roomName, connection) {
    const connectionId = typeof connection === "string" ? connection : connection.id
    await this.redis.sadd(this.roomKey(roomName), connectionId)
    await this.redis.sadd(this.connectionsRoomKey(connectionId), roomName)
  }

  async getRoomsForConnection(connection) {
    const connectionId = typeof connection === "string" ? connection : connection.id
    return await this.redis.smembers(this.connectionsRoomKey(connectionId))
  }

  async getAllRooms() {
    const keys = await this.redis.keys("mesh:room:*")
    return keys.map((key) => key.replace("mesh:room:", ""))
  }

  async removeFromRoom(roomName, connection) {
    const connectionId = typeof connection === "string" ? connection : connection.id
    const pipeline = this.redis.pipeline()
    pipeline.srem(this.roomKey(roomName), connectionId)
    pipeline.srem(this.connectionsRoomKey(connectionId), roomName)
    await pipeline.exec()
  }

  async removeFromAllRooms(connection) {
    const connectionId = typeof connection === "string" ? connection : connection.id
    const rooms = await this.redis.smembers(this.connectionsRoomKey(connectionId))
    const pipeline = this.redis.pipeline()
    for (const room of rooms) {
      pipeline.srem(this.roomKey(room), connectionId)
    }
    pipeline.del(this.connectionsRoomKey(connectionId))
    await pipeline.exec()
  }

  async clearRoom(roomName) {
    const connectionIds = await this.getRoomConnectionIds(roomName)
    const pipeline = this.redis.pipeline()
    for (const connectionId of connectionIds) {
      pipeline.srem(this.connectionsRoomKey(connectionId), roomName)
    }
    pipeline.del(this.roomKey(roomName))
    await pipeline.exec()
  }

  async deleteRoom(roomName) {
    const connectionIds = await this.getRoomConnectionIds(roomName)
    const pipeline = this.redis.pipeline()
    for (const connectionId of connectionIds) {
      pipeline.srem(this.connectionsRoomKey(connectionId), roomName)
    }
    pipeline.del(this.roomKey(roomName))
    pipeline.del(this.roomMetadataKey(roomName))
    await pipeline.exec()
  }

  async cleanupConnection(connection) {
    const rooms = await this.redis.smembers(this.connectionsRoomKey(connection.id))
    const pipeline = this.redis.pipeline()
    for (const room of rooms) {
      pipeline.srem(this.roomKey(room), connection.id)
    }
    pipeline.del(this.connectionsRoomKey(connection.id))
    await pipeline.exec()
  }

  async setMetadata(roomName, metadata, options) {
    let finalMetadata
    const strategy = options?.strategy || "replace"
    if (strategy === "replace") {
      finalMetadata = metadata
    } else {
      const existingMetadata = await this.getMetadata(roomName)
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
    await this.redis.hset(this.roomMetadataKey(roomName), "data", JSON.stringify(finalMetadata))
  }

  async getMetadata(roomName) {
    const data = await this.redis.hget(this.roomMetadataKey(roomName), "data")
    return data ? JSON.parse(data) : null
  }

  async getAllMetadata() {
    const keys = await this.redis.keys("mesh:roommeta:*")
    const result = []
    if (keys.length === 0) return result
    const pipeline = this.redis.pipeline()
    keys.forEach((key) => pipeline.hget(key, "data"))
    const results = await pipeline.exec()
    keys.forEach((key, index) => {
      const roomName = key.replace("mesh:roommeta:", "")
      const data = results?.[index]?.[1]
      if (data) {
        try { result.push({ id: roomName, metadata: JSON.parse(data) }) }
        catch (e) { serverLogger.error(`Failed to parse metadata for room ${roomName}:`, e) }
      }
    })
    return result
  }
}
