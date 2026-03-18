import { clientLogger } from "../../shared/index.js"

export function createChannelSubscriptions(client) {
  const subscriptions = client.channelSubscriptions

  async function handleMessage(payload) {
    const { channel, message } = payload
    const subscription = subscriptions.get(channel)
    if (subscription) {
      try {
        await subscription.callback(message)
      } catch (error) {
        clientLogger.error(`Error in channel callback for ${channel}:`, error)
      }
    }
  }

  /**
   * @param {string} channel
   * @param {(message: any) => void} callback
   * @param {{historyLimit?: number, since?: string}} [options]
   * @returns {Promise<{success: boolean, history: any[]}>}
   */
  async function subscribe(channel, callback, options) {
    subscriptions.set(channel, { callback, historyLimit: options?.historyLimit })
    const result = await client.command("mesh/subscribe-channel", {
      channel,
      historyLimit: options?.historyLimit,
      since: options?.since,
    })
    if (result.success && result.history && result.history.length > 0) {
      result.history.forEach((message) => callback(message))
    }
    return { success: result.success, history: result.history || [] }
  }

  /**
   * @param {string} channel
   * @returns {Promise<any>}
   */
  function unsubscribe(channel) {
    subscriptions.delete(channel)
    return client.command("mesh/unsubscribe-channel", { channel })
  }

  /**
   * @param {string} channel
   * @param {{limit?: number, since?: string}} [options]
   * @returns {Promise<{success: boolean, history: any[]}>}
   */
  async function getHistory(channel, options) {
    try {
      const result = await client.command("mesh/get-channel-history", {
        channel,
        limit: options?.limit,
        since: options?.since,
      })
      return { success: result.success, history: result.history || [] }
    } catch (error) {
      clientLogger.error(`Failed to get history for channel ${channel}:`, error)
      return { success: false, history: [] }
    }
  }

  async function resubscribe() {
    const promises = Array.from(subscriptions.entries()).map(async ([channel, { callback, historyLimit }]) => {
      try {
        await subscribe(channel, callback, { historyLimit })
        return true
      } catch (error) {
        clientLogger.error(`Failed to resubscribe to channel ${channel}:`, error)
        return false
      }
    })
    return Promise.allSettled(promises)
  }

  return { handleMessage, subscribe, unsubscribe, getHistory, resubscribe }
}
