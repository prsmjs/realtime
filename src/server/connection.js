import { EventEmitter } from "node:events"
import { parseCommand, stringifyCommand, serverLogger, Status } from "../shared/index.js"
import { generateConnectionId } from "./utils/ids.js"

export class Connection extends EventEmitter {
  constructor(socket, req, options, server) {
    super()
    this.socket = socket
    this.id = generateConnectionId()
    this.alive = true
    this.missedPongs = 0
    this.remoteAddress = req.socket.remoteAddress
    this.connectionOptions = options
    this.server = server
    this.status = Status.ONLINE
    this.latency = { start: 0, end: 0, ms: 0, interval: null }
    this.ping = { interval: null }

    this._applyListeners()
    this._startIntervals()
  }

  get isDead() {
    return !this.socket || this.socket.readyState !== this.socket.constructor.OPEN
  }

  _startIntervals() {
    this.latency.interval = setInterval(() => {
      if (!this.alive) return
      if (typeof this.latency.ms === "number") {
        this.send({ command: "latency", payload: this.latency.ms })
      }
      this.latency.start = Date.now()
      this.send({ command: "latency:request", payload: {} })
    }, this.connectionOptions.latencyInterval)

    this.ping.interval = setInterval(() => {
      if (!this.alive) {
        this.missedPongs++
        const maxMissedPongs = this.connectionOptions.maxMissedPongs ?? 1
        if (this.missedPongs > maxMissedPongs) {
          serverLogger.info(`Closing connection (${this.id}) due to missed pongs`)
          this.close()
          this.server.cleanupConnection(this)
          return
        }
      } else {
        this.missedPongs = 0
      }
      this.alive = false
      this.send({ command: "ping", payload: {} })
    }, this.connectionOptions.pingInterval)
  }

  stopIntervals() {
    clearInterval(this.latency.interval)
    clearInterval(this.ping.interval)
  }

  _applyListeners() {
    this.socket.on("close", () => {
      serverLogger.info("Client's socket closed:", this.id)
      this.status = Status.OFFLINE
      this.emit("close")
    })

    this.socket.on("error", (error) => {
      this.emit("error", error)
    })

    this.socket.on("message", (data) => {
      try {
        const command = parseCommand(data.toString())
        if (command.command === "latency:response") {
          this.latency.end = Date.now()
          this.latency.ms = this.latency.end - this.latency.start
          return
        } else if (command.command === "pong") {
          this.alive = true
          this.missedPongs = 0
          this.emit("pong", this.id)
          return
        }
        this.emit("message", data)
      } catch (error) {
        this.emit("error", error)
      }
    })
  }

  send(cmd) {
    if (this.isDead) return false
    try {
      this.socket.send(stringifyCommand(cmd))
      return true
    } catch (error) {
      this.emit("error", error)
      return false
    }
  }

  async close() {
    if (this.isDead) return false
    try {
      await new Promise((resolve, reject) => {
        this.socket.once("close", resolve)
        this.socket.once("error", reject)
        this.socket.close()
      })
      return true
    } catch (error) {
      this.emit("error", error)
      return false
    }
  }
}
