import process from 'node:process'
import Database from '@ludlovian/sqlite'
import Player from '@ludlovian/jonos-api'

import { refreshAlbums, refreshCoverArt } from './src/refresh.mjs'

import artworkCreateDDL from './src/artwork.mjs'
import libraryCreateDDL from './src/library.mjs'
import libraryRuntimeDDL from './src/library.runtime.mjs'

const mainDb = process.argv[2]

const artworkDb = 'db/artwork.db'
const libraryDb = 'db/library.db'
const prefix = 'x-file-cifs://pi2.local/data/'
const root = 'library/files'

const db = {}

main()

async function main () {
  setupDatabases()
  await setupLibrary()
  await refreshAlbums(db, root, prefix)
  await refreshCoverArt(db.artwork)
}

function setupDatabases () {
  db.main = new Database(mainDb)
  db.main.exec(mainCreateDDL)
  db.main.exec(mainRuntimeDDL)

  db.artwork = new Database(artworkDb)
  db.artwork.exec(artworkCreateDDL)

  db.library = new Database(libraryDb)
  db.library.exec(libraryCreateDDL)
  db.library.exec(libraryRuntimeDDL)
}

async function setupLibrary () {
  const { players } = await Player.discover()
  const uuids = players.map(({ uuid }) => uuid)
  const ensureMedia = 'insert into ensureMedia(url) values($url)'
  db.library.run(ensureMedia, { url: '' })
  uuids.forEach(uuid =>
    db.library.run(ensureMedia, { url: 'x-rincon:' + uuid })
  )
  uuids.forEach(uuid =>
    db.library.run(ensureMedia, { url: `x-rincon-queue:${uuid}#0` })
  )
  db.library.run(ensureMedia, {
    url: 'x-sonos-htastream:RINCON_B8E93741A6C201400:spdif'
  })

  setupOther()
  setupRadios()
}

function setupOther () {
  ;[
    { name: 'web', file: 'library/web.png' },
    { name: 'tv', file: 'library/tv.png' }
  ].forEach(({ name, file }) => {
    const artwork = getArtwork(file)
    db.library.run('update mediaType set artwork=$artwork where name=$name', {
      name,
      artwork
    })
  })
}

function setupRadios () {
  const type = db.library.pluck.get(`
    select id from mediaType where name='radio'
  `)
  ;[
    {
      url: 'x-rincon-mp3radio://https://allclassical.streamguys1.com/ac128kmp3',
      title: 'All Classical Radio',
      file: 'library/allclassical.png'
    }
  ].forEach(({ url, title, file }) => {
    const artwork = getArtwork(file)
    const sql = `
      insert or ignore into media (type, url, title, artwork)
      values ($type, $url, $title, $artwork)
    `
    db.library.run(sql, { type, url, title, artwork })
  })
}

function getArtwork (file) {
  db.artwork.run('insert or ignore into artwork(file) values ($file)', { file })
  return db.artwork.pluck.get('select id from artwork where file=$file', {
    file
  })
}

// ----------------------------------------------------------------
