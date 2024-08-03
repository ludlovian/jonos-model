import process from 'node:process'
import Database from '@ludlovian/sqlite'
import { tick } from './notify.mjs'
import config from './config.mjs'

import mainCreateDDL from './ddl.mjs'
import mainRuntimeDDL from './ddl.runtime.mjs'

import artworkCreateDDL from './artwork.mjs'

import libraryCreateDDL from './library.mjs'
import libraryRuntimeDDL from './library.runtime.mjs'

const schema = 2

export const db = setupDatabases(config.database)

function setupDatabases (path) {
  const db = new Database(path, {
    // we run the create DDL each time, just in case
    runtimeDDL: mainCreateDDL,
    checkSchema: schema
  })

  // Make sure the artwork DB exists
  //
  const artworkDbFile = getSetting(db, 'artworkDb')
  const artworkDb = new Database(artworkDbFile, {
    runtimeDDL: artworkCreateDDL
  })
  artworkDb.close()

  // Make sure the library exists
  //
  const libraryDbFile = getSetting(db, 'libraryDb')
  const libraryDb = new Database(libraryDbFile, {
    runtimeDDL: libraryCreateDDL
  })
  libraryDb.close()

  // Now connect the two into into the main db
  db.run('attach $file as library', { file: libraryDbFile })
  db.run('attach $file as artwork', { file: artworkDbFile })

  // Run the runtime DDLs
  db.exec(libraryRuntimeDDL)
  db.exec(mainRuntimeDDL)

  const dispose = db.notify(tick)

  // Fix up the close
  const origClose = db.close.bind(db)
  db.close = () => {
    dispose()
    housekeep({ shutdown: true })
    db.run('detach library')
    db.run('detach artwork')
    db.close = origClose
    origClose()
  }

  // Fix up getSetting
  db.getSetting = item => getSetting(db, item)

  return db
}

function getSetting (db, item) {
  return db.pluck.get('select value from settings where item=$item', { item })
}

export function housekeep (when = {}) {
  const vars = getEnvVars()
  for (const type of Object.keys(when)) {
    const sqls = db.pluck.all(
      'select sql from housekeeping where type=$type order by seq',
      { type }
    )
    for (let sql of sqls) {
      for (const [template, value] of vars) {
        sql = sql.replace(template, value)
      }
      db.exec(sql)
    }
  }
}

function getEnvVars () {
  const env = process.env
  let version = 'dev'
  if (env.NODE_ENV === 'production' && env.npm_package_version) {
    version = env.npm_package_version
  }
  return [['{{VERSION}}', version]]
}
