import process from 'node:process'
import Database from '@ludlovian/sqlite'
import config from './config.mjs'
import ddl from './ddl.mjs'

const schema = 2

const runtimeDDL = [
  'pragma journal_mode = wal;',
  'pragma foreign_keys = true;',
  'pragma recursive_triggers = true;',
  'pragma trusted_schema = false;',
  'pragma synchronous = normal;',
  'begin transaction;',
  ddl,
  'commit;'
].join('')

export const db = new Database(config.database, {
  runtimeDDL,
  checkSchema: schema
})

db.getSetting = function getSetting (item) {
  const sql = 'select value from settings where item=$item'
  return db.pluck.get(sql, { item })
}

export function housekeep (when = {}) {
  if (when.start) {
    const env = process.env
    let version = 'dev'
    if (env.NODE_ENV === 'production' && env.npm_package_version) {
      version = env.npm_package_version
    }
    const sql = "update systemStatus set value=$version where item='version'"
    db.run(sql, { version })
    db.exec(`
      update systemStatus set value=0
        where item in ('listeners', 'listening', 'jonosRefresh');
      update systemStatus set value=strftime('%FT%TZ','now')
        where item='started';
      delete from command;
      delete from playerChange;
      delete from player;
    `)
  }
  if (when.idle) {
    db.run('pragma wal_checkpoint(restart)')
  }
}
