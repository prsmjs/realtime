import { Context } from "../context.js"
import { CodeError } from "../../shared/index.js"

export class CommandManager {
  constructor() {
    this.commands = {}
    this.globalMiddlewares = []
    this.middlewares = {}
  }

  exposeCommand(command, callback, middlewares = []) {
    this.commands[command] = callback
    if (middlewares.length > 0) {
      this.useMiddlewareWithCommand(command, middlewares)
    }
  }

  useMiddleware(...middlewares) {
    this.globalMiddlewares.push(...middlewares)
  }

  useMiddlewareWithCommand(command, middlewares) {
    if (middlewares.length) {
      this.middlewares[command] = this.middlewares[command] || []
      this.middlewares[command] = middlewares.concat(this.middlewares[command])
    }
  }

  async runCommand(id, commandName, payload, connection, server) {
    const context = new Context(server, commandName, connection, payload)
    try {
      if (!this.commands[commandName]) {
        throw new CodeError(`Command "${commandName}" not found`, "ENOTFOUND", "CommandError")
      }
      for (const middleware of this.globalMiddlewares) {
        await middleware(context)
      }
      if (this.middlewares[commandName]) {
        for (const middleware of this.middlewares[commandName]) {
          await middleware(context)
        }
      }
      const result = await this.commands[commandName](context)
      connection.send({ id, command: commandName, payload: result })
    } catch (err) {
      const errorPayload = err instanceof Error
        ? { error: err.message, code: err.code || "ESERVER", name: err.name || "Error" }
        : { error: String(err), code: "EUNKNOWN", name: "UnknownError" }
      connection.send({ id, command: commandName, payload: errorPayload })
    }
  }

  getCommands() { return this.commands }
  hasCommand(commandName) { return !!this.commands[commandName] }
}
