export function ensureArray (x) {
  if (Array.isArray(x)) return x
  if (typeof x === 'string') {
    if (x.charAt(0) === '[') return JSON.parse(x)
    return [x]
  }
  return []
}

export function ensureOpts (x) {
  if (x && typeof x === 'object') return x
  if (typeof x !== 'string') return {}
  if (x.charAt(0) === '{') return JSON.parse(x)
  return Object.fromEntries(x.split(',').map(n => [n, true]))
}
