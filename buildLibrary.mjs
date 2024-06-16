import process from 'node:process'
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve, dirname, join, relative } from 'node:path'
import sortBy from '@ludlovian/sortby'

import config from './src/config.mjs'

main()

function main () {
  const media = loadMedia()
  const albums = loadAlbums()
  const data = { media, albums }
  const file = join(config.mediaRoot, 'library.json')
  writeFileSync(file, JSON.stringify(data, null, 2))
}

function loadAlbums () {
  const root = resolve(config.libraryRoot)
  const albums = []
  for (const mdFile of scanDir(root)) {
    albums.push(readAlbum(mdFile, root))
  }
  return albums
  console.log('\nDone')
}

function readAlbum (file, root) {
  const md = JSON.parse(readFileSync(file, 'utf8'))
  const dir = dirname(file)
  const relDir = relative(root, dir)
  process.stdout.write('.')
  const url = new URL(relDir + '/', config.libraryRootCifs).href
  return {
    url,
    artist: md.albumArtist,
    title: md.album,
    genre: md.genre,
    artwork: join(dir, 'cover.jpg'),
    tracks: md.tracks.map(t => ({
      url: new URL(t.file, url).href,
      title: t.title
    }))
  }
}

function loadMedia () {
  const root = resolve(config.mediaRoot)
  const file = join(root, config.mediaFile)
  const data = JSON.parse(readFileSync(file, 'utf8'))
  return data.map(md => {
    const out = {
      url: md.url,
      title: md.title,
      type: md.type
    }
    if (md.artwork) out.artwork = join(root, md.artwork)
    return out
  })
}

function * scanDir (dirPath, target = 'metadata.json') {
  const dirents = readdirSync(dirPath, { withFileTypes: true })
  for (const dirent of dirents.sort(sortBy('name'))) {
    if (dirent.isFile() && dirent.name === target) {
      yield join(dirPath, dirent.name)
    } else if (dirent.isDirectory()) {
      yield * scanDir(join(dirPath, dirent.name), target)
    }
  }
}
