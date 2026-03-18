import { EventEmitter } from "node:events"

export class MessageStream extends EventEmitter {
  constructor() {
    super()
    this.setMaxListeners(100)
  }

  publishMessage(channel, message, instanceId) {
    this.emit("message", { channel, message, instanceId, timestamp: Date.now() })
  }

  subscribeToMessages(callback) {
    this.on("message", callback)
  }

  unsubscribeFromMessages(callback) {
    this.off("message", callback)
  }
}
