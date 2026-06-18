import { provide, inject } from 'vue'

/**
 * Injection key under which the shared RealtimeClient is provided. Use it only
 * if you need to call Vue's `inject` directly; the composables resolve the
 * client for you through `injectRealtime`.
 * @type {symbol}
 */
export const REALTIME_KEY = Symbol('prsm-realtime')

/**
 * Provide a RealtimeClient to descendant components so the composables can
 * resolve it without being passed a client explicitly. Call this in a parent
 * component's setup (for example the app root) once the client exists.
 * @param {import('../client/index.js').RealtimeClient} client - The connected (or connecting) RealtimeClient to share with descendants.
 * @returns {import('../client/index.js').RealtimeClient} The same client, for convenient inline assignment.
 */
export function provideRealtime(client) {
  if (!client) throw new Error('provideRealtime requires a RealtimeClient instance')
  provide(REALTIME_KEY, client)
  return client
}

/**
 * Resolve the RealtimeClient for a composable. If a client is passed it wins;
 * otherwise the one provided by `provideRealtime` in an ancestor is used.
 * Throws when neither is available. Composables call this internally, so you
 * rarely need it directly.
 * @param {import('../client/index.js').RealtimeClient} [client] - An explicit client that takes precedence over the injected one.
 * @returns {import('../client/index.js').RealtimeClient} The resolved client.
 */
export function injectRealtime(client) {
  if (client) return client
  const provided = inject(REALTIME_KEY, null)
  if (!provided) {
    throw new Error('No RealtimeClient found. Call provideRealtime(client) in a parent, or pass { client } explicitly.')
  }
  return provided
}
