import { clientLogger } from "../../shared/index.js"

export function createRoomSubscriptions(client, presence) {
  const joinedRooms = client.joinedRooms

  /**
   * @param {string} roomName
   * @param {(update: {roomName: string, present: string[], states: Object<string, any>, joined?: string, left?: string}) => void} [onPresenceUpdate]
   * @returns {Promise<{success: boolean, present: string[]}>}
   */
  async function join(roomName, onPresenceUpdate) {
    const joinResult = await client.command("mesh/join-room", { roomName })
    if (!joinResult.success) return { success: false, present: [] }

    joinedRooms.set(roomName, onPresenceUpdate)

    if (!onPresenceUpdate) return { success: true, present: joinResult.present || [] }

    const { success: subSuccess } = await presence.subscribe(roomName, onPresenceUpdate)
    return { success: subSuccess, present: joinResult.present || [] }
  }

  /**
   * @param {string} roomName
   * @returns {Promise<{success: boolean}>}
   */
  async function leave(roomName) {
    const result = await client.command("mesh/leave-room", { roomName })
    if (result.success) {
      joinedRooms.delete(roomName)
      if (client.presenceSubscriptions.has(roomName)) {
        await presence.unsubscribe(roomName)
      }
    }
    return { success: result.success }
  }

  /**
   * @param {string} roomName
   * @returns {Promise<any>}
   */
  async function getMetadata(roomName) {
    try {
      const result = await client.command("mesh/get-room-metadata", { roomName })
      return result.metadata
    } catch (error) {
      clientLogger.error(`Failed to get metadata for room ${roomName}:`, error)
      return null
    }
  }

  async function resubscribe(presenceModule) {
    const promises = Array.from(joinedRooms.entries()).map(async ([roomName, presenceCallback]) => {
      try {
        await join(roomName, presenceCallback)
        return { roomName, success: true }
      } catch (error) {
        clientLogger.error(`Failed to rejoin room ${roomName}:`, error)
        return { roomName, success: false }
      }
    })
    const results = await Promise.allSettled(promises)
    return results
      .filter((r) => r.status === "fulfilled" && r.value.success)
      .map((r) => r.value.roomName)
  }

  return { join, leave, getMetadata, resubscribe }
}
