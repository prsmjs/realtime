export function convertToSqlPattern(pattern) {
  return pattern
    .replace(/\^/g, "")
    .replace(/\$/g, "")
    .replace(/\./g, "_")
    .replace(/\*/g, "%")
    .replace(/\+/g, "%")
    .replace(/\?/g, "_")
    .replace(/\\\\/g, "\\")
    .replace(/\\\./g, ".")
    .replace(/\\\*/g, "*")
    .replace(/\\\+/g, "+")
    .replace(/\\\?/g, "?")
}
