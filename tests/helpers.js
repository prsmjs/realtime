import Redis from "ioredis"
import { randomUUID } from "node:crypto"

const REDIS_HOST = process.env.REDIS_HOST || "127.0.0.1"
const REDIS_PORT = parseInt(process.env.REDIS_PORT || "6379")

let dbCounter = 0

export function createTestContext() {
  dbCounter++
  const workerId = parseInt(process.env.VITEST_POOL_WORKERID || "0")
  const db = (workerId * 5 + dbCounter) % 15 + 1
  const redis = new Redis({ host: REDIS_HOST, port: REDIS_PORT, db })

  return {
    redisOptions: { host: REDIS_HOST, port: REDIS_PORT, db },
    async flush() {
      await redis.flushdb()
      await new Promise((resolve) => setTimeout(resolve, 200))
    },
    async cleanup() {
      await redis.quit()
    },
  }
}

export function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
