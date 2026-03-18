import { convertToSqlPattern } from "../server/utils/pattern-conversion.js"
import { serverLogger } from "../shared/index.js"

export function createSqliteAdapter(options = {}) {
  const opts = { filename: ":memory:", ...options }
  let db = null
  let initialized = false

  async function createTables() {
    if (!db) throw new Error("Database not initialized")
    return new Promise((resolve, reject) => {
      db.run(
        `CREATE TABLE IF NOT EXISTS channel_messages (
          id TEXT PRIMARY KEY,
          channel TEXT NOT NULL,
          message TEXT NOT NULL,
          instance_id TEXT NOT NULL,
          timestamp INTEGER NOT NULL,
          metadata TEXT
        )`,
        (err) => {
          if (err) return reject(err)
          db.run("CREATE INDEX IF NOT EXISTS idx_channel_timestamp ON channel_messages (channel, timestamp)", (err) => {
            if (err) return reject(err)
            db.run(
              `CREATE TABLE IF NOT EXISTS records (
                record_id TEXT PRIMARY KEY,
                version INTEGER NOT NULL,
                value TEXT NOT NULL,
                timestamp INTEGER NOT NULL
              )`,
              (err) => {
                if (err) return reject(err)
                db.run("CREATE INDEX IF NOT EXISTS idx_records_timestamp ON records (timestamp)", (err) => {
                  if (err) return reject(err)
                  resolve()
                })
              }
            )
          })
        }
      )
    })
  }

  return {
    async initialize() {
      if (initialized) return
      const sqlite3 = await import("sqlite3")
      const { Database } = sqlite3.default || sqlite3
      return new Promise((resolve, reject) => {
        try {
          db = new Database(opts.filename, async (err) => {
            if (err) return reject(err)
            try {
              await createTables()
              initialized = true
              resolve()
            } catch (e) { reject(e) }
          })
        } catch (err) { reject(err) }
      })
    },

    async storeMessages(messages) {
      if (!db) throw new Error("Database not initialized")
      if (messages.length === 0) return
      return new Promise((resolve, reject) => {
        db.serialize(() => {
          db.run("BEGIN TRANSACTION")
          const stmt = db.prepare(
            `INSERT INTO channel_messages (id, channel, message, instance_id, timestamp, metadata) VALUES (?, ?, ?, ?, ?, ?)`
          )
          try {
            for (const msg of messages) {
              const metadata = msg.metadata ? JSON.stringify(msg.metadata) : null
              stmt.run(msg.id, msg.channel, msg.message, msg.instanceId, msg.timestamp, metadata)
            }
            stmt.finalize()
            db.run("COMMIT", (err) => { if (err) reject(err); else resolve() })
          } catch (err) { db.run("ROLLBACK"); reject(err) }
        })
      })
    },

    async getMessages(channel, since, limit = 50) {
      if (!db) throw new Error("Database not initialized")
      let query = "SELECT * FROM channel_messages WHERE channel = ?"
      const params = [channel]
      if (since !== undefined) {
        if (typeof since === "number") {
          query += " AND timestamp > ?"
          params.push(since)
        } else {
          const timestampQuery = await new Promise((resolve, reject) => {
            db.get("SELECT timestamp FROM channel_messages WHERE id = ?", [since], (err, row) => {
              if (err) reject(err)
              else resolve(row ? row.timestamp : 0)
            })
          })
          query += " AND timestamp > ?"
          params.push(timestampQuery)
        }
      }
      query += " ORDER BY timestamp ASC LIMIT ?"
      params.push(limit)
      return new Promise((resolve, reject) => {
        db.all(query, params, (err, rows) => {
          if (err) return reject(err)
          resolve(rows.map((row) => ({
            id: row.id,
            channel: row.channel,
            message: row.message,
            instanceId: row.instance_id,
            timestamp: row.timestamp,
            metadata: row.metadata ? JSON.parse(row.metadata) : undefined,
          })))
        })
      })
    },

    async storeRecords(records) {
      if (!db) throw new Error("Database not initialized")
      if (records.length === 0) return
      return new Promise((resolve, reject) => {
        db.serialize(() => {
          db.run("BEGIN TRANSACTION")
          const stmt = db.prepare(
            `INSERT OR REPLACE INTO records (record_id, version, value, timestamp) VALUES (?, ?, ?, ?)`
          )
          try {
            for (const record of records) {
              stmt.run(record.recordId, record.version, record.value, record.timestamp)
            }
            stmt.finalize()
            db.run("COMMIT", (err) => {
              if (err) { db.run("ROLLBACK"); reject(err) }
              else resolve()
            })
          } catch (err) { db.run("ROLLBACK"); reject(err) }
        })
      })
    },

    async getRecords(pattern) {
      if (!db) throw new Error("Database not initialized")
      const sqlPattern = convertToSqlPattern(pattern)
      return new Promise((resolve, reject) => {
        db.all(
          `SELECT record_id, version, value, timestamp FROM records WHERE record_id LIKE ? ORDER BY timestamp DESC`,
          [sqlPattern],
          (err, rows) => {
            if (err) return reject(err)
            resolve(rows.map((row) => ({
              recordId: row.record_id,
              version: row.version,
              value: row.value,
              timestamp: row.timestamp,
            })))
          }
        )
      })
    },

    async close() {
      if (!db) return
      return new Promise((resolve, reject) => {
        db.close((err) => {
          if (err) return reject(err)
          db = null
          initialized = false
          resolve()
        })
      })
    },
  }
}
