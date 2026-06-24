import { convertToSqlPattern } from "../server/utils/pattern-conversion.js"
import { serverLogger } from "../shared/index.js"

/**
 * @typedef {Object} SqliteAdapterOptions
 * @property {string} [filename=":memory:"] - Path to the SQLite database file. Defaults to `":memory:"`, which keeps everything in memory and discards it on close, so set a real file path to persist across restarts.
 */

/**
 * @typedef {Object} ChannelMessage
 * @property {string} id - Unique identifier for the message, used as the cursor when paginating with `getMessages`.
 * @property {string} channel - Name of the channel the message belongs to.
 * @property {string} message - Serialized message payload as stored by the server.
 * @property {string} instanceId - Identifier of the server instance that produced the message.
 * @property {number} timestamp - Creation time in milliseconds since the Unix epoch.
 * @property {Object} [metadata] - Arbitrary metadata object associated with the message, or `undefined` when none was stored.
 */

/**
 * @typedef {Object} StoredRecord
 * @property {string} recordId - Unique identifier for the record.
 * @property {number} version - Monotonically increasing version number for optimistic concurrency.
 * @property {string} value - Serialized record value as stored by the server.
 * @property {number} timestamp - Last write time in milliseconds since the Unix epoch.
 */

/**
 * @typedef {Object} PersistenceAdapter
 * @property {() => Promise<void>} initialize - Opens the database connection and creates the required tables and indexes if they do not exist. Idempotent; safe to call more than once.
 * @property {(messages: ChannelMessage[]) => Promise<void>} storeMessages - Inserts a batch of channel messages in a single transaction. A zero-length array is a no-op.
 * @property {(channel: string, since?: (number|string), limit?: number) => Promise<ChannelMessage[]>} getMessages - Returns messages for a channel ordered oldest first. `since` may be a millisecond timestamp or a message `id` to page after; omit it to start from the beginning. `limit` caps the result count (default 50).
 * @property {(records: StoredRecord[]) => Promise<void>} storeRecords - Upserts a batch of records by `recordId` in a single transaction, replacing any existing row. A zero-length array is a no-op.
 * @property {(recordIds: string[]) => Promise<void>} removeRecords - Deletes the records with the given ids in a single transaction. A zero-length array is a no-op. Ids that are not present are ignored.
 * @property {(pattern: string) => Promise<StoredRecord[]>} getRecords - Returns records whose `recordId` matches the glob-style pattern, ordered newest first. The pattern is converted to a SQL LIKE pattern internally.
 * @property {() => Promise<void>} close - Closes the database connection and resets internal state. A no-op if the adapter was never initialized.
 */

/**
 * Creates a SQLite-backed persistence adapter for `@prsm/realtime`. Pass the
 * returned object as the server's `persistence` option to keep channel
 * messages and record state durable across restarts. The connection is opened
 * lazily by `initialize`, which the server calls during startup. Requires the
 * optional `sqlite3` peer dependency to be installed.
 *
 * @param {SqliteAdapterOptions} [options={}] - Adapter configuration.
 * @returns {PersistenceAdapter} The persistence adapter the server interacts with.
 */
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

    async removeRecords(recordIds) {
      if (!db) throw new Error("Database not initialized")
      if (recordIds.length === 0) return
      return new Promise((resolve, reject) => {
        db.serialize(() => {
          db.run("BEGIN TRANSACTION")
          const stmt = db.prepare(`DELETE FROM records WHERE record_id = ?`)
          try {
            for (const recordId of recordIds) stmt.run(recordId)
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
