import untilSignal from '@ludlovian/until-signal'

import config from './config.mjs'

export async function verifyCall (fn, verify, msg = '') {
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

export async function verifyCallPoll (verify, msg = '') {
  const n = config.callPollCount
  for (let i = 0; i < n; i++) {
    const data = await verify()
    if (data) return data
    await delay(config.callPollDelay)
  }
  throw new Error(`Failed to verify${msg ? ': ' + msg : ''}`)
}

function delay (ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}
