import { clientLogger } from "../../shared/index.js"

export function createRecordSubscriptions(client) {
  const subscriptions = client.recordSubscriptions

  async function handleUpdate(payload) {
    const { recordId, full, patch, version } = payload

    for (const [collectionId, collectionSub] of client.collectionSubscriptions.entries()) {
      if (collectionSub.ids.has(recordId) && collectionSub.onDiff) {
        try {
          await collectionSub.onDiff({
            added: [],
            removed: [],
            changed: [{ id: recordId, record: full }],
            version,
          })
        } catch (error) {
          clientLogger.error(`Error in collection record update callback for ${collectionId}:`, error)
        }
      }
    }

    const subscription = subscriptions.get(recordId)
    if (!subscription) return

    if (patch) {
      if (version !== subscription.localVersion + 1) {
        clientLogger.warn(
          `Desync detected for record ${recordId}. Expected version ${subscription.localVersion + 1}, got ${version}. Resubscribing to request full record.`
        )
        await unsubscribe(recordId)
        await subscribe(recordId, subscription.callback, { mode: subscription.mode })
        return
      }
      subscription.localVersion = version
      if (subscription.callback) await subscription.callback({ recordId, patch, version })
    } else if (full !== undefined) {
      subscription.localVersion = version
      if (subscription.callback) await subscription.callback({ recordId, full, version })
    }
  }

  async function handleDeleted(payload) {
    const { recordId, version } = payload
    const subscription = subscriptions.get(recordId)
    if (subscription && subscription.callback) {
      try {
        await subscription.callback({ recordId, deleted: true, version })
      } catch (error) {
        clientLogger.error(`Error in record deletion callback for ${recordId}:`, error)
      }
    }
    subscriptions.delete(recordId)
  }

  /**
   * @param {string} recordId
   * @param {(update: {recordId: string, full?: any, patch?: import('fast-json-patch').Operation[], version: number, deleted?: boolean}) => void} callback
   * @param {{mode?: 'full' | 'patch'}} [options]
   * @returns {Promise<{success: boolean, record: any, version: number}>}
   */
  async function subscribe(recordId, callback, options) {
    const mode = options?.mode ?? "full"
    try {
      const result = await client.command("mesh/subscribe-record", { recordId, mode })
      if (result.success) {
        subscriptions.set(recordId, { callback, localVersion: result.version, mode })
        if (callback) await callback({ recordId, full: result.record, version: result.version })
      }
      return { success: result.success, record: result.record ?? null, version: result.version ?? 0 }
    } catch (error) {
      clientLogger.error(`Failed to subscribe to record ${recordId}:`, error)
      return { success: false, record: null, version: 0 }
    }
  }

  /**
   * @param {string} recordId
   * @returns {Promise<boolean>}
   */
  async function unsubscribe(recordId) {
    try {
      const success = await client.command("mesh/unsubscribe-record", { recordId })
      if (success) subscriptions.delete(recordId)
      return success
    } catch (error) {
      clientLogger.error(`Failed to unsubscribe from record ${recordId}:`, error)
      return false
    }
  }

  /**
   * @param {string} recordId
   * @param {any} newValue
   * @param {Object} [options]
   * @returns {Promise<boolean>}
   */
  async function write(recordId, newValue, options) {
    try {
      const result = await client.command("mesh/publish-record-update", { recordId, newValue, options })
      return result.success === true
    } catch (error) {
      clientLogger.error(`Failed to publish update for record ${recordId}:`, error)
      return false
    }
  }

  async function resubscribe() {
    const promises = Array.from(subscriptions.entries()).map(async ([recordId, { callback, mode }]) => {
      try {
        await subscribe(recordId, callback, { mode })
        return true
      } catch (error) {
        clientLogger.error(`Failed to resubscribe to record ${recordId}:`, error)
        return false
      }
    })
    return Promise.allSettled(promises)
  }

  return { handleUpdate, handleDeleted, subscribe, unsubscribe, write, resubscribe }
}
