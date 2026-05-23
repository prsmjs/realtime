import { provide, inject } from 'vue'

export const REALTIME_KEY = Symbol('prsm-realtime')

export function provideRealtime(client) {
  if (!client) throw new Error('provideRealtime requires a RealtimeClient instance')
  provide(REALTIME_KEY, client)
  return client
}

export function injectRealtime(client) {
  if (client) return client
  const provided = inject(REALTIME_KEY, null)
  if (!provided) {
    throw new Error('No RealtimeClient found. Call provideRealtime(client) in a parent, or pass { client } explicitly.')
  }
  return provided
}
