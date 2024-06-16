import untilSignal from '@ludlovian/until-signal'

import config from './config.mjs'

export default async function verifyCall (fn, verify, msg = '') {
  const n = config.callRetries
  for (let i = 0; i < n; i++) {
    await fn()
    if (await untilSignal(verify, config.callVerifyTimeout)) return
    if (msg) {
      console.warn(`Attempt #${i + 1} of ${msg} failed. Retrying`)
    }
  }
  throw new Error(`Failed after ${n} attempts${msg ? ': ' + msg : ''}`)
}
