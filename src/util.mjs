import assert from 'node:assert/strict'
import { setTimeout as sleep } from 'node:timers/promises'
import timeout from '@ludlovian/timeout'
import config from './config.mjs'

const FAST_FAIL = true

export function fatal (err) {
  console.error('Fatal error:\n')
  console.error(err)
  process.exit(1)
}

async function retryEx (fn, opts) {
  const {
    retries = config.callRetries,
    timeout: ms = config.callTimeout,
    delay = config.callRetryDelay,
    fatal: isFatal,
    safe
  } = opts

  let _err
  for (let i = 0; i < retries; i++) {
    try {
      return await timeout(Promise.resolve(fn()), ms)
    } catch (err) {
      // whilst debugging
      if (
        FAST_FAIL ||
        err instanceof assert.AssertionError ||
        err instanceof SyntaxError ||
        err instanceof TypeError
      ) {
        throw err
      }
      _err ??= err
      console.error('Retrying %s', fn)
      await sleep(delay)
    }
  }
  if (safe) {
    console.error('Ignoring error:')
    console.error(_err)
    return _err
  }
  if (isFatal) return fatal(_err)
  throw _err
}

export function retry (fn, opts = {}) {
  return retryEx(fn, { fatal: true, ...opts })
}

export function safeRetry (fn, opts) {
  return retryEx(fn, { ...opts, safe: true })
}

export async function verify (verifyFunc, opts = {}) {
  const { retries = config.verifyTries, delay = config.verifyDelay } = opts
  for (let i = 0; i < retries; i++) {
    const result = await verifyFunc()
    if (result) return result
    await sleep(delay)
  }
  throw new Error(`Failed to verify: ${verifyFunc}`)
}
