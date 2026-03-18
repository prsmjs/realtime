export class CollectionManager {
  constructor({ redis, emitError }) {
    this.redis = redis
    this.emitError = emitError
    this.exposedCollections = []
    this.collectionSubscriptions = new Map()
  }

  exposeCollection(pattern, resolver) {
    this.exposedCollections.push({ pattern, resolver })
  }

  async isCollectionExposed(collectionId, _connection) {
    const matchedPattern = this.exposedCollections.find((entry) =>
      typeof entry.pattern === "string" ? entry.pattern === collectionId : entry.pattern.test(collectionId)
    )
    return !!matchedPattern
  }

  async resolveCollection(collectionId, connection) {
    const matchedPattern = this.exposedCollections.find((entry) =>
      typeof entry.pattern === "string" ? entry.pattern === collectionId : entry.pattern.test(collectionId)
    )
    if (!matchedPattern) throw new Error(`Collection "${collectionId}" is not exposed`)
    try {
      return await Promise.resolve(matchedPattern.resolver(connection, collectionId))
    } catch (error) {
      this.emitError(new Error(`Failed to resolve collection "${collectionId}": ${error}`))
      throw error
    }
  }

  async addSubscription(collectionId, connectionId, connection) {
    if (!this.collectionSubscriptions.has(collectionId)) {
      this.collectionSubscriptions.set(collectionId, new Map())
    }
    const records = await this.resolveCollection(collectionId, connection)
    const ids = records.map((record) => record.id)
    const version = 1
    this.collectionSubscriptions.get(collectionId).set(connectionId, { version })
    await this.redis.set(`mesh:collection:${collectionId}:${connectionId}`, JSON.stringify(ids))
    return { ids, records, version }
  }

  async removeSubscription(collectionId, connectionId) {
    const collectionSubs = this.collectionSubscriptions.get(collectionId)
    if (collectionSubs?.has(connectionId)) {
      collectionSubs.delete(connectionId)
      if (collectionSubs.size === 0) this.collectionSubscriptions.delete(collectionId)
      await this.redis.del(`mesh:collection:${collectionId}:${connectionId}`)
      return true
    }
    return false
  }

  async publishRecordChange(recordId) {
    try {
      await this.redis.publish("mesh:collection:record-change", recordId)
    } catch (error) {
      this.emitError(new Error(`Failed to publish record change for ${recordId}: ${error}`))
    }
  }

  async cleanupConnection(connection) {
    const connectionId = connection.id
    const cleanupPromises = []
    this.collectionSubscriptions.forEach((subscribers, collectionId) => {
      if (!subscribers.has(connectionId)) return
      subscribers.delete(connectionId)
      if (subscribers.size === 0) this.collectionSubscriptions.delete(collectionId)
      cleanupPromises.push(
        this.redis.del(`mesh:collection:${collectionId}:${connectionId}`).then(() => {}).catch((err) => {
          this.emitError(new Error(`Failed to clean up collection subscription for "${collectionId}": ${err}`))
        })
      )
    })
    await Promise.all(cleanupPromises)
  }

  async listRecordsMatching(pattern, options) {
    try {
      const recordKeyPrefix = "mesh:record:"
      const keys = []
      let cursor = "0"
      do {
        const result = await this.redis.scan(cursor, "MATCH", `${recordKeyPrefix}${pattern}`, "COUNT", options?.scanCount ?? 100)
        cursor = result[0]
        keys.push(...result[1])
      } while (cursor !== "0")
      if (keys.length === 0) return []
      const records = await this.redis.mget(keys)
      const cleanRecordIds = keys.map((key) => key.substring(recordKeyPrefix.length))
      let processedRecords = records
        .map((val, index) => {
          if (val === null) return null
          try {
            const parsed = JSON.parse(val)
            const recordId = cleanRecordIds[index]
            return parsed.id === recordId ? parsed : { ...parsed, id: recordId }
          } catch (e) {
            this.emitError(new Error(`Failed to parse record for processing: ${val} - ${e.message}`))
            return null
          }
        })
        .filter((record) => record !== null)
      if (options?.map) processedRecords = processedRecords.map(options.map)
      if (options?.sort) processedRecords.sort(options.sort)
      if (options?.slice) {
        const { start, count } = options.slice
        processedRecords = processedRecords.slice(start, start + count)
      }
      return processedRecords
    } catch (error) {
      this.emitError(new Error(`Failed to list records matching "${pattern}": ${error.message}`))
      return []
    }
  }

  getCollectionSubscriptions() { return this.collectionSubscriptions }

  updateSubscriptionVersion(collectionId, connectionId, version) {
    const collectionSubs = this.collectionSubscriptions.get(collectionId)
    if (collectionSubs?.has(connectionId)) {
      collectionSubs.set(connectionId, { version })
    }
  }
}
