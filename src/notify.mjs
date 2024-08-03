// Notification manager
//

let ticking = false
const callbacks = new Set()

export function notify (callback) {
  callbacks.add(callback)
  return () => callbacks.delete(callback)
}

export function tick () {
  if (ticking) return
  ticking = true
  Promise.resolve().then(notifyCallbacks)
}

function notifyCallbacks () {
  const fns = [...callbacks]
  fns.map(fn => fn())
  ticking = false
}

notify.clear = function clear () {
  callbacks.clear()
}

notify.count = function count () {
  return callbacks.size
}
