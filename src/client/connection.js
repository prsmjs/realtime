import { EventEmitter } from "eventemitter3";
import { CodeError, parseCommand, Status, stringifyCommand } from "../shared/index.js";
import { IdManager } from "./ids.js";
import { Queue } from "./queue.js";

export class Connection extends EventEmitter {
  socket = null;
  ids = new IdManager();
  queue = new Queue();
  callbacks = {};
  status = Status.OFFLINE;
  connectionId;

  /** @param {WebSocket|null} socket */
  constructor(socket) {
    super();
    this.socket = socket;
    if (socket) {
      this.applyListeners();
    }
  }

  get isDead() {
    return !this.socket || this.socket.readyState !== WebSocket.OPEN;
  }

  /**
   * @param {{id?: number, command: string, payload?: Object}} command
   * @returns {boolean}
   */
  send(command) {
    try {
      if (!this.isDead) {
        this.socket?.send(stringifyCommand(command));
        return true;
      }
      return false;
    } catch (e) {
      return false;
    }
  }

  /**
   * @param {{id?: number, command: string, payload?: Object}} command
   * @param {number} [expiresIn] - queue expiry in ms
   * @returns {boolean}
   */
  sendWithQueue(command, expiresIn) {
    const success = this.send(command);

    if (!success) {
      this.queue.add(command, expiresIn);
    }

    return success;
  }

  /**
   * @param {boolean} [reconnection] - if true, drains the queued commands
   * @returns {void}
   */
  applyListeners(reconnection = false) {
    if (!this.socket) return;

    const drainQueue = () => {
      while (!this.queue.isEmpty) {
        const item = this.queue.pop();
        if (item) {
          this.send(item.value);
        }
      }
    };

    if (reconnection) {
      drainQueue();
    }

    this.socket.onclose = () => {
      this.status = Status.OFFLINE;
      this.emit("close");
      this.emit("disconnect");
    };

    this.socket.onerror = (error) => {
      this.emit("error", error);
    };

    this.socket.onmessage = (event) => {
      try {
        const data = parseCommand(event.data);

        this.emit("message", data);

        if (data.command === "mesh/assign-id") {
          this.connectionId = data.payload;
          this.emit("id-assigned", data.payload);
        } else if (data.command === "latency:request") {
          this.emit("latency:request", data.payload);
          this.command("latency:response", data.payload, null);
        } else if (data.command === "latency") {
          this.emit("latency", data.payload);
        } else if (data.command === "ping") {
          this.emit("ping");
          this.command("pong", {}, null);
        } else {
          this.emit(data.command, data.payload);
        }

        if (data.id !== undefined && this.callbacks[data.id]) {
          this.callbacks[data.id](data.payload);
        }
      } catch (error) {
        this.emit("error", error);
      }
    };
  }

  /**
   * @param {string} command - command name
   * @param {Object} [payload] - command payload
   * @param {number|null} [expiresIn] - timeout in ms, null to fire-and-forget (default 30000)
   * @param {(result: any, error?: Error) => void} [callback] - optional node-style callback
   * @returns {Promise<any>}
   */
  command(command, payload, expiresIn = 30_000, callback) {
    const id = this.ids.reserve();
    const cmd = { id, command, payload: payload ?? {} };

    this.sendWithQueue(cmd, expiresIn || 30000);

    if (expiresIn === null) {
      this.ids.release(id);
      return Promise.resolve();
    }

    let timer

    const responsePromise = new Promise((resolve, reject) => {
      this.callbacks[id] = (result, error) => {
        clearTimeout(timer)
        this.ids.release(id);
        delete this.callbacks[id];
        if (error) reject(error)
        else resolve(result)
      };
    });

    const timeoutPromise = new Promise((_, reject) => {
      timer = setTimeout(() => {
        if (!this.callbacks[id]) return;
        this.ids.release(id);
        delete this.callbacks[id];
        reject(new CodeError(`Command timed out after ${expiresIn}ms.`, "ETIMEOUT", "TimeoutError"));
      }, expiresIn);
    });

    if (typeof callback === "function") {
      Promise.race([responsePromise, timeoutPromise])
        .then((result) => callback(result))
        .catch((error) => callback(null, error));
      return responsePromise;
    }

    return Promise.race([responsePromise, timeoutPromise]);
  }

  /** @returns {boolean} */
  close() {
    if (this.isDead) return false;

    try {
      this.socket?.close();
      return true;
    } catch (e) {
      return false;
    }
  }
}
