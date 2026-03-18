export class BroadcastManager {
  constructor({ connectionManager, roomManager, instanceId, pubClient, getPubSubChannel, emitError }) {
    this.connectionManager = connectionManager
    this.roomManager = roomManager
    this.instanceId = instanceId
    this.pubClient = pubClient
    this.getPubSubChannel = getPubSubChannel
    this.emitError = emitError
  }

  async sendTo(connectionId, command, payload) {
    try {
      await this._publishOrSend([connectionId], { command, payload })
    } catch (err) {
      this.emitError(new Error(`Failed to send command "${command}" to ${connectionId}: ${err}`))
    }
  }

  async broadcast(command, payload, connections) {
    const cmd = { command, payload }
    try {
      if (connections) {
        const allConnectionIds = connections.map(({ id }) => id)
        const connectionIds = await this.connectionManager.getAllConnectionIds()
        const filteredIds = allConnectionIds.filter((id) => connectionIds.includes(id))
        await this._publishOrSend(filteredIds, cmd)
      } else {
        const allConnectionIds = await this.connectionManager.getAllConnectionIds()
        await this._publishOrSend(allConnectionIds, cmd)
      }
    } catch (err) {
      this.emitError(new Error(`Failed to broadcast command "${command}": ${err}`))
    }
  }

  async broadcastRoom(roomName, command, payload) {
    const connectionIds = await this.roomManager.getRoomConnectionIds(roomName)
    try {
      await this._publishOrSend(connectionIds, { command, payload })
    } catch (err) {
      this.emitError(new Error(`Failed to broadcast command "${command}": ${err}`))
    }
  }

  async broadcastExclude(command, payload, exclude) {
    const excludedIds = new Set((Array.isArray(exclude) ? exclude : [exclude]).map(({ id }) => id))
    try {
      const connectionIds = (await this.connectionManager.getAllConnectionIds()).filter((id) => !excludedIds.has(id))
      await this._publishOrSend(connectionIds, { command, payload })
    } catch (err) {
      this.emitError(new Error(`Failed to broadcast command "${command}": ${err}`))
    }
  }

  async broadcastRoomExclude(roomName, command, payload, exclude) {
    const excludedIds = new Set((Array.isArray(exclude) ? exclude : [exclude]).map(({ id }) => id))
    try {
      const connectionIds = (await this.roomManager.getRoomConnectionIds(roomName)).filter((id) => !excludedIds.has(id))
      await this._publishOrSend(connectionIds, { command, payload })
    } catch (err) {
      this.emitError(new Error(`Failed to broadcast command "${command}": ${err}`))
    }
  }

  async _publishOrSend(connectionIds, command) {
    if (connectionIds.length === 0) return
    const connectionInstanceMapping = await this.connectionManager.getInstanceIdsForConnections(connectionIds)
    const instanceMap = {}
    for (const connectionId of connectionIds) {
      const instanceId = connectionInstanceMapping[connectionId]
      if (instanceId) {
        if (!instanceMap[instanceId]) instanceMap[instanceId] = []
        instanceMap[instanceId].push(connectionId)
      }
    }
    for (const [instanceId, targetConnectionIds] of Object.entries(instanceMap)) {
      if (targetConnectionIds.length === 0) continue
      if (instanceId === this.instanceId) {
        targetConnectionIds.forEach((connectionId) => {
          const connection = this.connectionManager.getLocalConnection(connectionId)
          if (connection && !connection.isDead) connection.send(command)
        })
      } else {
        const messagePayload = { targetConnectionIds, command }
        const message = JSON.stringify(messagePayload)
        try {
          await this.pubClient.publish(this.getPubSubChannel(instanceId), message)
        } catch (err) {
          this.emitError(new Error(`Failed to publish command "${command.command}": ${err}`))
        }
      }
    }
  }
}
