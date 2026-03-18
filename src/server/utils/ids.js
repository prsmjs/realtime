import { randomUUID } from "node:crypto"

export function generateConnectionId() {
  return randomUUID()
}
