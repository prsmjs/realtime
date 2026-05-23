import { Context } from "../context.js"
import { CodeError } from "../../shared/index.js"

export class CommandManager {
  constructor(opts = {}) {
    this.commands = {}
    this.globalMiddlewares = []
    this.middlewares = {}
    this._tracer = opts.tracer ?? null
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
    const exec = async () => {
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
      return await this.commands[commandName](context)
    }
    try {
      let result
      if (this._tracer && !commandName.startsWith('rt/')) {
        const handle = this._tracer.startSpan(`realtime.command:${commandName}`, {
          'realtime.command': commandName,
          'realtime.connectionId': connection.id,
        }, { kind: 'server' })
        try {
          result = await this._tracer.run(handle.context, exec)
        } catch (err) {
          handle.setError(err)
          throw err
        } finally {
          handle.end()
        }
      } else {
        result = await exec()
      }
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
