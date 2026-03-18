export class CodeError extends Error {
  constructor(message, code, name) {
    super(message)
    if (typeof code === "string") this.code = code
    this.name = typeof name === "string" ? name : "CodeError"
  }
}
