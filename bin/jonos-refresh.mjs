#!/usr/bin/env node
import process from 'node:process'
import { readdir, stat, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import Database from '@ludlovian/sqlite'
import Player from '@ludlovian/jonos-api'
import sortBy from '@ludlovian/sortby'
import Debug from '@ludlovian/debug'

import config from '../src/config.mjs'
import mainCreateDDL from '../src/ddl.mjs'
import artworkCreateDDL from '../src/artwork.mjs'
import libraryCreateDDL from '../src/library.mjs'
import libraryRuntimeDDL from '../src/library.runtime.mjs'

const debug = Debug('jonos-model:refresh*')

const mainDb = process.argv[2]

const db = {}

main()

async function main () {
  setupDatabases()
  await setupLibrary()
  const prefix = getSetting(db.main, 'cifsPrefix')
  const root = getSetting(db.main, 'libraryRoot')
  await refreshAlbums(db, root, prefix)
  await refreshCoverArt(db.artwork)
  debug('Refresh complete')
}

function setupDatabases () {
  debug('Refreshing database at: ', mainDb)
  db.main = new Database(mainDb)
  db.main.exec(mainCreateDDL)

  const artworkDb = getSetting(db.main, 'artworkDb')
  debug('Artwork database at: ', artworkDb)
  db.artwork = new Database(artworkDb)
  db.artwork.exec(artworkCreateDDL)

  const libraryDb = getSetting(db.main, 'libraryDb')
  debug('Library database at: ', libraryDb)
  db.library = new Database(libraryDb)
  db.library.exec(libraryCreateDDL)
  db.library.exec(libraryRuntimeDDL)
}

function getSetting (db, item) {
  return db.pluck.get('select value from settings where item=$item', { item })
}

async function setupLibrary () {
  setupDefaultArtwork()

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

  setupRadios()
}

function setupDefaultArtwork () {
  ;[
    { name: 'web', file: 'library/web.png' },
    { name: 'tv', file: 'library/tv.png' }
  ].forEach(({ name, file }) => {
    const artwork = ensureArtwork(db.artwork, file)
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
    const artwork = ensureArtwork(db.artwork, file)
    const sql = `
      insert or ignore into media (type, url, title, artwork)
      values ($type, $url, $title, $artwork)
    `
    db.library.run(sql, { type, url, title, artwork })
  })
}

export async function refreshAlbums (db, root, prefix) {
  debug('Refreshing albums found in: ', root)
  debug('Assigning CIFS prefix:', prefix)

  let i = 0
  const report = () => debug('%d albums checked', i)

  for await (const rec of scanDir(root)) {
    if (rec.name === 'metadata.json') {
      const { parentPath: path, file } = rec
      const row = db.library.get(
        'select id, hash from album where path=$path',
        { path }
      )
      const hash = await getHash(file)
      if (!row || hash !== row.hash) {
        debug('Adding album %s', path)
        const artwork = ensureArtwork(db.artwork, join(root, path, 'cover.jpg'))
        const metadata = await readFile(file, 'utf8')
        if (row) {
          db.library.run('insert into removeAlbum(path) values($path)', {
            path
          })
        }
        db.library.run(
          `insert into addAlbum(path,hash,prefix,metadata,artwork)
          values($path,$hash,$prefix,$metadata,$artwork)`,
          { path, hash, prefix, metadata, artwork }
        )
      }
      if (++i % 100 === 0) report()
    }
  }
  report()
  db.library.run('rebuildSearch')
}

function ensureArtwork (db, file) {
  db.run('insert or ignore into artwork(file) values($file)', { file })
  return db.pluck.get('select id from artwork where file=$file', { file })
}

export async function refreshCoverArt (db) {
  debug('Refreshing cover art')
  let i = 0
  const report = () => debug('%d artworks checked', i)

  await db.asyncTransaction(config.commitDelay, async () => {
    const recs = db.all('select id, file, hash from artwork')
    for (const rec of recs) {
      const hash = await getHash(rec.file)
      if (!hash) {
        console.error('%s is missing', rec.file)
        return
      }
      if (hash !== rec.hash) {
        debug('Adding art %s', rec.file)
        const image = await readFile(rec.file)
        db.run('update artwork set hash=$hash, image=$image where id=$id', {
          id: rec.id,
          hash,
          image
        })
      }
      if (++i % 100 === 0) report()
    }
    report()
  })
}

async function getHash (path) {
  try {
    const stats = await stat(path)
    return `${stats.size}-${Math.floor(stats.mtimeMs)}`
  } catch (err) {
    if (err.code !== 'ENOENT') throw err
    return null
  }
}

async function * scanDir (root, path = '') {
  const dir = join(root, path)
  let dirents = await readdir(dir, { withFileTypes: true })
  dirents = dirents.sort(sortBy('name'))
  for (const dirent of dirents) {
    const { name } = dirent
    if (dirent.isDirectory()) {
      yield * scanDir(root, join(path, name))
    } else if (dirent.isFile()) {
      yield {
        file: join(root, path, name),
        name,
        parentPath: path,
        path: join(path, name)
      }
    }
  }
}
