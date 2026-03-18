export function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

export function deepMerge(target, source) {
  if (!isObject(target) || !isObject(source)) return source

  const result = { ...target }
  for (const key in source) {
    if (Object.prototype.hasOwnProperty.call(source, key)) {
      result[key] = isObject(source[key]) && isObject(target[key])
        ? deepMerge(target[key], source[key])
        : source[key]
    }
  }
  return result
}
