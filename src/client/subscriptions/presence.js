import { clientLogger } from "../../shared/index.js"

export function createPresenceSubscriptions(client) {
  const subscriptions = client.presenceSubscriptions

  async function handleUpdate(payload) {
    const { roomName } = payload
    const callback = subscriptions.get(roomName)
    if (callback) await callback(payload)
  }

  /**
   * @param {string} roomName
   * @param {(update: {roomName: string, present: string[], states: Object<string, any>, joined?: string, left?: string}) => void} callback
   * @returns {Promise<{success: boolean, present: string[], states?: Object<string, any>}>}
   */
  async function subscribe(roomName, callback) {
    try {
      const result = await client.command("mesh/subscribe-presence", { roomName })
      if (result.success) {
        subscriptions.set(roomName, callback)
        if (result.present && result.present.length > 0) await callback(result)
      }
      return { success: result.success, present: result.present || [], states: result.states || {} }
    } catch (error) {
      clientLogger.error(`Failed to subscribe to presence for room ${roomName}:`, error)
      return { success: false, present: [] }
    }
  }

  /**
   * @param {string} roomName
   * @returns {Promise<boolean>}
   */
  async function unsubscribe(roomName) {
    try {
      const success = await client.command("mesh/unsubscribe-presence", { roomName })
      if (success) subscriptions.delete(roomName)
      return success
    } catch (error) {
      clientLogger.error(`Failed to unsubscribe from presence for room ${roomName}:`, error)
      return false
    }
  }

  /**
   * @param {string} roomName
   * @param {{state: any, expireAfter?: number, silent?: boolean}} options
   * @returns {Promise<any>}
   */
  async function publishState(roomName, options) {
    try {
      return await client.command("mesh/publish-presence-state", {
        roomName,
        state: options.state,
        expireAfter: options.expireAfter,
        silent: options.silent,
      })
    } catch (error) {
      clientLogger.error(`Failed to publish presence state for room ${roomName}:`, error)
      return false
    }
  }

  /**
   * @param {string} roomName
   * @returns {Promise<any>}
   */
  async function clearState(roomName) {
    try {
      return await client.command("mesh/clear-presence-state", { roomName })
    } catch (error) {
      clientLogger.error(`Failed to clear presence state for room ${roomName}:`, error)
      return false
    }
  }

  async function forceUpdate(roomName) {
    try {
      const handler = subscriptions.get(roomName)
      if (!handler) return false
      const result = await client.command("mesh/get-presence-state", { roomName }, 5000).catch((err) => {
        clientLogger.error(`Failed to get presence state for room ${roomName}:`, err)
        return { success: false }
      })
      if (!result.success) return false
      if (handler.init && typeof handler.init === "function") {
        handler.init(result.present, result.states || {})
      }
      return true
    } catch (error) {
      clientLogger.error(`Failed to force presence update for room ${roomName}:`, error)
      return false
    }
  }

  return { handleUpdate, subscribe, unsubscribe, publishState, clearState, forceUpdate }
}
