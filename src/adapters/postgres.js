import { convertToSqlPattern } from "../server/utils/pattern-conversion.js"
import { serverLogger } from "../shared/index.js"

export function createPostgresAdapter(options = {}) {
  const opts = {
    host: "localhost",
    port: 5432,
    database: "mesh_test",
    user: "mesh",
    password: "mesh_password",
    max: 10,
    ...options,
  }
  let pool = null
  let initialized = false

  async function createTables() {
    if (!pool) throw new Error("Database not initialized")
    const client = await pool.connect()
    try {
      await client.query(`
        CREATE TABLE IF NOT EXISTS channel_messages (
          id TEXT PRIMARY KEY, channel TEXT NOT NULL, message TEXT NOT NULL,
          instance_id TEXT NOT NULL, timestamp BIGINT NOT NULL, metadata JSONB
        )
      `)
      await client.query(`CREATE INDEX IF NOT EXISTS idx_channel_timestamp ON channel_messages (channel, timestamp)`)
      await client.query(`
        CREATE TABLE IF NOT EXISTS records (
          record_id TEXT PRIMARY KEY, version INTEGER NOT NULL,
          value JSONB NOT NULL, timestamp BIGINT NOT NULL
        )
      `)
      await client.query(`CREATE INDEX IF NOT EXISTS idx_records_timestamp ON records (timestamp)`)
    } finally { client.release() }
  }

  return {
    async initialize() {
      if (initialized) return
      try {
        const pg = await import("pg")
        const Pool = pg.default?.Pool || pg.Pool
        pool = new Pool(
          opts.connectionString
            ? { connectionString: opts.connectionString, max: opts.max }
            : { host: opts.host, port: opts.port, database: opts.database, user: opts.user, password: opts.password, ssl: opts.ssl, max: opts.max }
        )
        await createTables()
        initialized = true
      } catch (err) {
        serverLogger.error("Error initializing PostgreSQL database:", err)
        throw err
      }
    },

    async storeMessages(messages) {
      if (!pool) throw new Error("Database not initialized")
      if (messages.length === 0) return
      const client = await pool.connect()
      try {
        await client.query("BEGIN")
        for (const msg of messages) {
          await client.query(
            `INSERT INTO channel_messages (id, channel, message, instance_id, timestamp, metadata) VALUES ($1, $2, $3, $4, $5, $6)`,
            [msg.id, msg.channel, msg.message, msg.instanceId, msg.timestamp, msg.metadata || null]
          )
        }
        await client.query("COMMIT")
      } catch (err) { await client.query("ROLLBACK"); throw err }
      finally { client.release() }
    },

    async getMessages(channel, since, limit = 50) {
      if (!pool) throw new Error("Database not initialized")
      let query = "SELECT * FROM channel_messages WHERE channel = $1"
      const params = [channel]
      let paramIndex = 2
      if (since !== undefined) {
        if (typeof since === "number") {
          query += ` AND timestamp > $${paramIndex}`
          params.push(since)
          paramIndex++
        } else {
          const timestampResult = await pool.query("SELECT timestamp FROM channel_messages WHERE id = $1", [since])
          const timestamp = timestampResult.rows[0]?.timestamp || 0
          query += ` AND timestamp > $${paramIndex}`
          params.push(timestamp)
          paramIndex++
        }
      }
      query += ` ORDER BY timestamp ASC LIMIT $${paramIndex}`
      params.push(limit)
      const result = await pool.query(query, params)
      return result.rows.map((row) => ({
        id: row.id, channel: row.channel, message: row.message,
        instanceId: row.instance_id, timestamp: parseInt(row.timestamp), metadata: row.metadata,
      }))
    },

    async storeRecords(records) {
      if (!pool) throw new Error("Database not initialized")
      if (records.length === 0) return
      const client = await pool.connect()
      try {
        await client.query("BEGIN")
        for (const record of records) {
          await client.query(
            `INSERT INTO records (record_id, version, value, timestamp) VALUES ($1, $2, $3, $4)
             ON CONFLICT (record_id) DO UPDATE SET version = $2, value = $3, timestamp = $4`,
            [record.recordId, record.version, record.value, record.timestamp]
          )
        }
        await client.query("COMMIT")
      } catch (err) { await client.query("ROLLBACK"); throw err }
      finally { client.release() }
    },

    async getRecords(pattern) {
      if (!pool) throw new Error("Database not initialized")
      const sqlPattern = convertToSqlPattern(pattern)
      const result = await pool.query(
        `SELECT record_id, version, value, timestamp FROM records WHERE record_id LIKE $1 ORDER BY timestamp DESC`,
        [sqlPattern]
      )
      return result.rows.map((row) => ({
        recordId: row.record_id, version: row.version,
        value: row.value, timestamp: parseInt(row.timestamp),
      }))
    },

    async close() {
      if (!pool) return
      await pool.end()
      pool = null
      initialized = false
    },
  }
}
