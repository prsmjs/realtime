import { serverLogger } from "../../shared/index.js"
import { PUB_SUB_CHANNEL_PREFIX, RECORD_PUB_SUB_CHANNEL } from "../utils/constants.js"

export class PubSubManager {
  constructor({ subClient, pubClient, instanceId, connectionManager, recordManager, recordSubscriptions, getChannelSubscriptions, emitError, collectionManager }) {
    this.subClient = subClient
    this.pubClient = pubClient
    this.instanceId = instanceId
    this.connectionManager = connectionManager
    this.recordManager = recordManager
    this.recordSubscriptions = recordSubscriptions
    this.getChannelSubscriptions = getChannelSubscriptions
    this.emitError = emitError
    this.collectionManager = collectionManager || null

    this.collectionUpdateTimeouts = new Map()
    this.collectionMaxDelayTimeouts = new Map()
    this.pendingCollectionUpdates = new Map()
    this.COLLECTION_UPDATE_DEBOUNCE_MS = 50
    this.COLLECTION_MAX_DELAY_MS = 200
  }

  subscribeToInstanceChannel() {
    const channel = `${PUB_SUB_CHANNEL_PREFIX}${this.instanceId}`
    this._subscriptionPromise = new Promise((resolve, reject) => {
      this.subClient.subscribe(channel, RECORD_PUB_SUB_CHANNEL, "mesh:collection:record-change")
      this.subClient.psubscribe("mesh:presence:updates:*", (err) => {
        if (err) {
          this.emitError(new Error(`Failed to subscribe to channels/patterns: ${JSON.stringify({ cause: err })}`))
          reject(err)
          return
        }
        resolve()
      })
    })
    this._setupMessageHandlers()
    return this._subscriptionPromise
  }

  _setupMessageHandlers() {
    this.subClient.on("message", async (channel, message) => {
      if (channel.startsWith(PUB_SUB_CHANNEL_PREFIX)) {
        this._handleInstancePubSubMessage(channel, message)
      } else if (channel === RECORD_PUB_SUB_CHANNEL) {
        this._handleRecordUpdatePubSubMessage(message)
      } else if (channel === "mesh:collection:record-change") {
        this._handleCollectionRecordChange(message)
      } else {
        const subscribers = this.getChannelSubscriptions(channel)
        if (subscribers) {
          for (const connection of subscribers) {
            if (!connection.isDead) {
              connection.send({ command: "mesh/subscription-message", payload: { channel, message } })
            }
          }
        }
      }
    })

    this.subClient.on("pmessage", async (pattern, channel, message) => {
      if (pattern === "mesh:presence:updates:*") {
        const subscribers = this.getChannelSubscriptions(channel)
        if (subscribers) {
          try {
            const payload = JSON.parse(message)
            subscribers.forEach((connection) => {
              if (!connection.isDead) {
                connection.send({ command: "mesh/presence-update", payload })
              } else {
                subscribers.delete(connection)
              }
            })
          } catch (e) {
            this.emitError(new Error(`Failed to parse presence update: ${message}`))
          }
        }
      }
    })
  }

  _handleInstancePubSubMessage(_channel, message) {
    try {
      const parsedMessage = JSON.parse(message)
      if (!parsedMessage || !Array.isArray(parsedMessage.targetConnectionIds) || !parsedMessage.command || typeof parsedMessage.command.command !== "string") {
        throw new Error("Invalid message format")
      }
      const { targetConnectionIds, command } = parsedMessage
      targetConnectionIds.forEach((connectionId) => {
        const connection = this.connectionManager.getLocalConnection(connectionId)
        if (connection && !connection.isDead) connection.send(command)
      })
    } catch (err) {
      this.emitError(new Error(`Failed to parse message: ${message}`))
    }
  }

  _handleRecordUpdatePubSubMessage(message) {
    try {
      const parsedMessage = JSON.parse(message)
      const { recordId, newValue, patch, version, deleted } = parsedMessage
      if (!recordId || typeof version !== "number") throw new Error("Invalid record update message format")
      const subscribers = this.recordSubscriptions.get(recordId)
      if (!subscribers) return
      subscribers.forEach((mode, connectionId) => {
        const connection = this.connectionManager.getLocalConnection(connectionId)
        if (connection && !connection.isDead) {
          if (deleted) {
            connection.send({ command: "mesh/record-deleted", payload: { recordId, version } })
          } else if (mode === "patch" && patch) {
            connection.send({ command: "mesh/record-update", payload: { recordId, patch, version } })
          } else if (mode === "full" && newValue !== undefined) {
            connection.send({ command: "mesh/record-update", payload: { recordId, full: newValue, version } })
          }
        } else if (!connection || connection.isDead) {
          subscribers.delete(connectionId)
          if (subscribers.size === 0) this.recordSubscriptions.delete(recordId)
        }
      })
      if (deleted) this.recordSubscriptions.delete(recordId)
    } catch (err) {
      this.emitError(new Error(`Failed to parse record update message: ${message}`))
    }
  }

  async _handleCollectionRecordChange(changedRecordId) {
    if (!this.collectionManager) return
    const collectionSubsMap = this.collectionManager.getCollectionSubscriptions()
    const affectedCollections = new Set()
    for (const [collectionId] of collectionSubsMap.entries()) {
      affectedCollections.add(collectionId)
    }
    for (const collectionId of affectedCollections) {
      const existingTimeout = this.collectionUpdateTimeouts.get(collectionId)
      if (existingTimeout) clearTimeout(existingTimeout)
      if (!this.pendingCollectionUpdates.has(collectionId)) {
        this.pendingCollectionUpdates.set(collectionId, new Set())
      }
      this.pendingCollectionUpdates.get(collectionId).add(changedRecordId)
      const debounceTimeout = setTimeout(async () => {
        await this._processCollectionUpdates(collectionId)
      }, this.COLLECTION_UPDATE_DEBOUNCE_MS)
      this.collectionUpdateTimeouts.set(collectionId, debounceTimeout)
      if (!this.collectionMaxDelayTimeouts.has(collectionId)) {
        const maxDelayTimeout = setTimeout(async () => {
          await this._processCollectionUpdates(collectionId)
        }, this.COLLECTION_MAX_DELAY_MS)
        this.collectionMaxDelayTimeouts.set(collectionId, maxDelayTimeout)
      }
    }
  }

  async _processCollectionUpdates(collectionId) {
    const changedRecordIds = this.pendingCollectionUpdates.get(collectionId)
    if (!changedRecordIds || changedRecordIds.size === 0) return
    const debounceTimeout = this.collectionUpdateTimeouts.get(collectionId)
    const maxDelayTimeout = this.collectionMaxDelayTimeouts.get(collectionId)
    if (debounceTimeout) { clearTimeout(debounceTimeout); this.collectionUpdateTimeouts.delete(collectionId) }
    if (maxDelayTimeout) { clearTimeout(maxDelayTimeout); this.collectionMaxDelayTimeouts.delete(collectionId) }
    this.pendingCollectionUpdates.delete(collectionId)
    if (!this.collectionManager) return
    const subscribers = this.collectionManager.getCollectionSubscriptions().get(collectionId)
    if (!subscribers || subscribers.size === 0) return

    for (const [connectionId, { version: currentCollVersion }] of subscribers.entries()) {
      try {
        const connection = this.connectionManager.getLocalConnection(connectionId)
        if (!connection || connection.isDead) continue

        const newRecords = await this.collectionManager.resolveCollection(collectionId, connection)
        const newRecordIds = newRecords.map((record) => record.id)
        const previousRecordIdsKey = `mesh:collection:${collectionId}:${connectionId}`
        const previousRecordIdsStr = await this.pubClient.get(previousRecordIdsKey)
        const previousRecordIds = previousRecordIdsStr ? JSON.parse(previousRecordIdsStr) : []

        const addedIds = newRecordIds.filter((id) => !previousRecordIds.includes(id))
        const added = newRecords.filter((record) => addedIds.includes(record.id))
        const removedIds = previousRecordIds.filter((id) => !newRecordIds.includes(id))

        const removed = []
        for (const removedId of removedIds) {
          try {
            const record = await this.recordManager.getRecord(removedId)
            removed.push(record || { id: removedId })
          } catch { removed.push({ id: removedId }) }
        }

        const deletedRecords = []
        for (const recordId of changedRecordIds) {
          if (previousRecordIds.includes(recordId) && !newRecordIds.includes(recordId)) {
            deletedRecords.push(recordId)
          }
        }

        const changeAffectsMembership = added.length > 0 || removed.length > 0
        const deletionAffectsExistingMember = deletedRecords.length > 0

        if (changeAffectsMembership || deletionAffectsExistingMember) {
          const newCollectionVersion = currentCollVersion + 1
          this.collectionManager.updateSubscriptionVersion(collectionId, connectionId, newCollectionVersion)
          await this.pubClient.set(previousRecordIdsKey, JSON.stringify(newRecordIds))
          connection.send({
            command: "mesh/collection-diff",
            payload: { collectionId, added, removed, version: newCollectionVersion },
          })
        }

        for (const recordId of changedRecordIds) {
          if (newRecordIds.includes(recordId)) {
            try {
              const { record, version } = await this.recordManager.getRecordAndVersion(recordId)
              if (record) {
                connection.send({ command: "mesh/record-update", payload: { recordId, version, full: record } })
              }
            } catch (recordError) {
              serverLogger.info(`Record ${recordId} not found during collection update (likely deleted).`)
            }
          }
        }
      } catch (connError) {
        this.emitError(new Error(`Error processing collection ${collectionId} for connection ${connectionId}: ${connError}`))
      }
    }
  }

  getSubscriptionPromise() { return this._subscriptionPromise }
  getPubSubChannel(instanceId) { return `${PUB_SUB_CHANNEL_PREFIX}${instanceId}` }

  async cleanup() {
    for (const timeout of this.collectionUpdateTimeouts.values()) clearTimeout(timeout)
    this.collectionUpdateTimeouts.clear()
    for (const timeout of this.collectionMaxDelayTimeouts.values()) clearTimeout(timeout)
    this.collectionMaxDelayTimeouts.clear()
    this.pendingCollectionUpdates.clear()
    if (this.subClient && this.subClient.status !== "end") {
      const channel = `${PUB_SUB_CHANNEL_PREFIX}${this.instanceId}`
      await Promise.all([
        new Promise((resolve) => { this.subClient.unsubscribe(channel, RECORD_PUB_SUB_CHANNEL, "mesh:collection:record-change", () => resolve()) }),
        new Promise((resolve) => { this.subClient.punsubscribe("mesh:presence:updates:*", () => resolve()) }),
      ])
    }
  }
}
