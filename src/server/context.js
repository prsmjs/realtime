export class Context {
  constructor(server, command, connection, payload) {
    this.server = server
    this.command = command
    this.connection = connection
    this.payload = payload
  }

  /** @returns {Promise<any>} */
  getMetadata() {
    return this.server.connectionManager.getMetadata(this.connection)
  }

  /**
   * @param {any} metadata
   * @param {{strategy?: 'replace' | 'merge' | 'deepMerge'}} [options]
   * @returns {Promise<void>}
   */
  setMetadata(metadata, options) {
    return this.server.connectionManager.setMetadata(this.connection, metadata, options)
  }
}
