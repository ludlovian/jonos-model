import { readdir, stat, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import sortBy from '@ludlovian/sortby'
import Debug from '@ludlovian/debug'

import config from './config.mjs'
import { db } from './database.mjs'

const debug = Debug('jonos-model:refresh')

export async function refreshCoverArt () {
  let i = 0
  const report = () => debug('%d artworks checked', i)

  await db.asyncTransaction(config.commitDelay, async () => {
    const sql = 'select id, file, hash from artwork'
    for (const { id, file, hash } of db.all(sql)) {
      const newHash = await getHash(file)
      if (!newHash) {
        console.error('%s is missing', file)
        return
      }
      if (hash !== newHash) {
        await addArtwork(file, { hash, id })
      }
      if (++i % 100 === 0) report()
    }
    report()
  })
}

export async function refreshAlbums () {
  let i = 0
  const report = () => debug('%d albums checked', i)

  await db.asyncTransaction(config.commitDelay, async () => {
    const root = db.pluck.get('select libraryRoot from settings')
    const unseen = new Set(db.pluck.all('select path from album'))
    for await (const rec of scanDir(root)) {
      if (rec.name === 'metadata.json') {
        const path = rec.parentPath
        unseen.delete(path)
        await checkAlbum(rec.file, path, join(root, path))
        if (++i % 100 === 0) report()
      }
    }
    report()
    for (const path of unseen) {
      db.run('delete from album where path=$path', { path })
    }
    db.run('rebuildSearch')
  })
}

export function prune () {}

async function checkAlbum (file, path, albumDir) {
  const hash = await getHash(file)
  let sql
  sql = 'select id, hash from album where path = $path'
  const rec = db.get(sql, { path })
  if (rec && rec.hash === hash) return
  debug('Adding album %s', path)
  const metadata = await readFile(file, 'utf8')
  if (rec) {
    sql = `
      update album set hash = $hash, metadata = jsonb($metadata)
      where id = $id
    `
    db.update(sql, { hash, metadata })
  } else {
    sql = `
      insert into album (path, hash, metadata)
        values ($path, $hash, jsonb($metadata))
    `
    db.run(sql, { path, hash, metadata })
  }
  sql = 'select id, cover from album where path=$path'
  const { id, cover } = db.get(sql, { path })

  await setCoverArt(id, join(albumDir, cover))
}

async function setCoverArt (albumId, file) {
  let sql = 'select id from artwork where file=$file'
  let artwork = db.pluck.get(sql, { file })
  if (!artwork) artwork = await addArtwork(file)
  sql = `
    update media set artwork = $artwork
    where id in (select id from trackEx where albumId = $albumId)
  `
  db.run(sql, { artwork, albumId })
}

async function addArtwork (file, { hash, id } = {}) {
  if (!hash) hash = await getHash(file)
  debug('Adding artwork %s', file)
  const image = await readFile(file)
  if (id) {
    const sql = `
      update artwork set (hash, image) = ($hash, $image)
      where id = $id
    `
    db.run(sql, { id, hash, image })
    return id
  } else {
    const sql = `
      insert into artwork(file, hash, image)
      values ($file, $hash, $image)
      returning id
    `
    id = db.pluck.get(sql, { file, hash, image })
    return id
  }
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
