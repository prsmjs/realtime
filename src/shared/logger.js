/** @enum {number} */
export const LogLevel = {
  NONE: 0,
  ERROR: 1,
  WARN: 2,
  INFO: 3,
  DEBUG: 4,
}

const isBrowser = typeof window !== "undefined" && typeof window.document !== "undefined"

export class Logger {
  constructor(config) {
    this.config = {
      level: config?.level ?? LogLevel.INFO,
      prefix: config?.prefix ?? "[mesh]",
      styling: config?.styling ?? isBrowser,
    }
  }

  configure(config) {
    this.config = { ...this.config, ...config }
  }

  info(...args) {
    if (this.config.level >= LogLevel.INFO) this._log("log", ...args)
  }

  warn(...args) {
    if (this.config.level >= LogLevel.WARN) this._log("warn", ...args)
  }

  error(...args) {
    if (this.config.level >= LogLevel.ERROR) this._log("error", ...args)
  }

  debug(...args) {
    if (this.config.level >= LogLevel.DEBUG) this._log("debug", ...args)
  }

  _log(method, ...args) {
    if (this.config.styling && isBrowser) {
      const style = "background: #000; color: #FFA07A; padding: 2px 4px; border-radius: 2px;"
      console[method](`%c${this.config.prefix}%c`, style, "", ...args)
    } else {
      console[method](this.config.prefix, ...args)
    }
  }
}

export const clientLogger = new Logger({ level: LogLevel.ERROR, styling: true })
export const serverLogger = new Logger({ level: LogLevel.ERROR, styling: false })
export const logger = isBrowser ? clientLogger : serverLogger
