import process from 'node:process'

import { parse as parseMs } from '@lukeed/ms'
import camelCase from 'pixutil/camel-case'
import guess from 'pixutil/guess'

const PREFIX = 'JONOS_'

const defaults = {
  libraryRoot: './library/files',
  libraryRootCifs: 'x-file-cifs://data2.local/data/',
  radioRoot: './library/',
  radioFile: 'radio.json',

  callRetries: 3,
  callVerifyTimeout: parseMs('3s'),

  idleTimeout: parseMs('10s')
}

function envVars (prefix) {
  return Object.fromEntries(
    Object.entries(process.env)
      .filter(([key]) => key.startsWith(prefix))
      .map(([key, value]) => [camelCase(key.slice(prefix.length)), value])
  )
}

function convertObject (o) {
  return Object.fromEntries(
    Object.entries(o).map(([key, value]) => [key, guess(value)])
  )
}

export default {
  ...defaults,
  ...convertObject(envVars(PREFIX))
}
