import Bouncer from '@ludlovian/bouncer'
import config from './config.mjs'
// Notification manager
//

let ticking = false
const callbacks = new Set()

export function notify (callback, opts = {}) {
  const { debounce = config.notifyDebounce } = opts
  let bouncer
  if (debounce) {
    bouncer = new Bouncer({ after: debounce, fn: callback })
    callback = bouncer.fire
  }
  callbacks.add(callback)
  return dispose

  function dispose () {
    callbacks.delete(callback)
    if (bouncer) bouncer.cancel()
  }
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
