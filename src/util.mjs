import assert from 'node:assert/strict'
import { setTimeout as sleep } from 'node:timers/promises'
import Parsley from '@ludlovian/parsley'
import timeout from '@ludlovian/timeout'
import config from './config.mjs'

const FAST_FAIL = false

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
    return null
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
    if (await verifyFunc()) return true
    await sleep(delay)
  }
  return false
}

export function xmlToObject (xml) {
  const out = {}
  if (!xml) return null
  xml = xml.trim()
  if (!xml.startsWith('<')) return null
  const elem = Parsley.from(xml, { safe: true })
  if (!elem) return null
  for (const el of elem.findAll(p => p.isText)) {
    let key = el.type.replace(/.*:/, '')
    key = key.charAt(0).toLowerCase() + key.slice(1)
    out[key] = el.text
  }
  return out
}
