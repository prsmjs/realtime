/**
 * @typedef {{ id?: number, command: string, payload: any }} Command
 */

/** @param {string} data */
export function parseCommand(data) {
  try {
    return JSON.parse(data)
  } catch {
    return { command: "", payload: {} }
  }
}

/** @param {Command} command */
export function stringifyCommand(command) {
  return JSON.stringify(command)
}
