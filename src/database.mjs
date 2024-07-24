import process from 'node:process'
import Database from '@ludlovian/sqlite'
import config from './config.mjs'
import ddl from './ddl.mjs'

const schema = 1

const runtimeDDL = [
  'pragma journal_mode = wal;',
  'pragma foreign_keys = true;',
  'pragma recursive_triggers = true;',
  'begin transaction;',
  ddl,
  'commit;'
].join('')

export const db = new Database(config.database, {
  runtimeDDL,
  checkSchema: schema
})

export function housekeep (when = {}) {
  if (when.start) {
    const env = process.env
    let version = 'dev'
    if (env.NODE_ENV === 'production' && env.npm_package_version) {
      version = env.npm_package_version
    }
    db.run('delete from task')
    const sql = 'update systemStatus set started=julianday(),version=$version'
    db.run(sql, { version })
  }
  if (when.idle) {
    db.run('pragma wal_checkpoint(truncate)')
  }
}
