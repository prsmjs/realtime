import { clientLogger } from "../../shared/index.js"

export function createCollectionSubscriptions(client) {
  const subscriptions = client.collectionSubscriptions

  async function handleDiff(payload) {
    const { collectionId, added, removed, version } = payload
    const subscription = subscriptions.get(collectionId)
    if (!subscription) return

    if (version !== subscription.version + 1) {
      clientLogger.warn(
        `Desync detected for collection ${collectionId}. Expected version ${subscription.version + 1}, got ${version}. Resubscribing.`
      )
      await unsubscribe(collectionId)
      await subscribe(collectionId, { onDiff: subscription.onDiff })
      return
    }

    subscription.version = version
    for (const record of added) subscription.ids.add(record.id)
    for (const record of removed) subscription.ids.delete(record.id)

    if (subscription.onDiff) {
      try {
        await subscription.onDiff({
          added: added.map((record) => ({ id: record.id, record })),
          removed: removed.map((record) => ({ id: record.id, record })),
          changed: [],
          version,
        })
      } catch (error) {
        clientLogger.error(`Error in collection diff callback for ${collectionId}:`, error)
      }
    }
  }

  /**
   * @param {string} collectionId
   * @param {{onDiff?: (diff: {added: Array<{id: string, record: any}>, removed: Array<{id: string, record: any}>, changed: Array<{id: string, record: any}>, version: number}) => void}} [options]
   * @returns {Promise<{success: boolean, ids: string[], records: any[], version: number}>}
   */
  async function subscribe(collectionId, options = {}) {
    try {
      const result = await client.command("mesh/subscribe-collection", { collectionId })
      if (result.success) {
        subscriptions.set(collectionId, {
          ids: new Set(result.ids),
          version: result.version,
          onDiff: options.onDiff,
        })
        if (options.onDiff) {
          try {
            await options.onDiff({ added: result.records, removed: [], changed: [], version: result.version })
          } catch (error) {
            clientLogger.error(`Error in initial collection diff callback for ${collectionId}:`, error)
          }
        }
      }
      return { success: result.success, ids: result.ids || [], records: result.records || [], version: result.version || 0 }
    } catch (error) {
      clientLogger.error(`Failed to subscribe to collection ${collectionId}:`, error)
      return { success: false, ids: [], records: [], version: 0 }
    }
  }

  /**
   * @param {string} collectionId
   * @returns {Promise<boolean>}
   */
  async function unsubscribe(collectionId) {
    try {
      const success = await client.command("mesh/unsubscribe-collection", { collectionId })
      if (success) subscriptions.delete(collectionId)
      return success
    } catch (error) {
      clientLogger.error(`Failed to unsubscribe from collection ${collectionId}:`, error)
      return false
    }
  }

  async function resubscribe() {
    const promises = Array.from(subscriptions.entries()).map(async ([collectionId, subscription]) => {
      try {
        await subscribe(collectionId, { onDiff: subscription.onDiff })
        return true
      } catch (error) {
        clientLogger.error(`Failed to resubscribe to collection ${collectionId}:`, error)
        return false
      }
    })
    return Promise.allSettled(promises)
  }

  return { handleDiff, subscribe, unsubscribe, resubscribe }
}
