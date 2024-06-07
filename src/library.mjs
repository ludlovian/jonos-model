import { readdir, readFile } from 'node:fs/promises'
import { resolve, dirname, relative, join } from 'node:path'

import sortBy from 'sortby'
import addSignals from '@ludlovian/signal-extra/add-signals'

import config from './config.mjs'

export default class Library {
  constructor () {
    addSignals(this, {
      albums: [],
      albumById: () => new Map(this.albums.map(a => [a.albumId, a])),
      trackByUrl: () =>
        new Map(
          this.albums
            .map(a => a.tracks)
            .flat()
            .map(t => [t.url, t])
        ),

      radio: [],
      radioByUrl: () => new Map(this.radio.map(r => [r.url, r])),

      scanning: false
    })
  }

  async scan () {
    this.scanning = true
    this.radio = await Radio.load()
    this.albums = []
    const rootDir = resolve(config.libraryRoot)
    for await (const mdFile of scanDir(rootDir)) {
      const albumId = relative(rootDir, dirname(mdFile))
      const album = Object.assign(await Album.read(mdFile), { albumId })
      this.albums = [...this.albums, album]
    }
    this.scanning = false
  }

  locate (url) {
    url = url + ''
    if (url.startsWith('x-file-cifs:')) {
      return this.trackByUrl.get(url) ?? new UnknownTrack(url)
    } else if (url.startsWith('x-rincon-mp3radio:')) {
      return this.radioByUrl.get(url) ?? new Radio({ url })
    } else {
      return undefined
    }
  }
}

class Radio {
  id
  url
  artwork
  name

  static async load () {
    const root = resolve(config.radioRoot)
    const file = join(root, config.radioFile)
    const md = JSON.parse(await readFile(file, 'utf8'))
    return md.map(md => {
      const r = new Radio(md)
      if (r.artwork) r.artwork = join(root, r.artwork)
      return r
    })
  }

  constructor (md) {
    Object.assign(this, md)
  }
}

class Album {
  albumId
  artist
  genre
  title
  tracks
  coverFile

  static async read (mdFile) {
    const a = new Album()
    const md = JSON.parse(await readFile(mdFile, 'utf8'))
    return Object.assign(a, {
      artist: md.albumArtist,
      genre: md.genre ?? '',
      title: md.album,
      coverFile: 'cover.jpg',
      tracks: md.tracks
        .map(t => Track.read(a, t))
        .sort(sortBy('discNumber').thenBy('trackNumber'))
        .map((t, index) => Object.assign(t, { index }))
    })
  }

  get url () {
    return this.albumId
      ? new URL(this.albumId, config.libraryRootCifs).href
      : undefined
  }

  get albumArt () {
    return this.albumId ? join(this.albumId, this.coverFile) : undefined
  }
}

class Track {
  #album
  index
  file
  title
  discNumber
  trackNumber
  artist

  static read (album, md) {
    const t = new Track()
    t.#album = album

    return Object.assign(t, {
      file: md.file,
      title: md.title,
      discNumber: md.discNumber,
      trackNumber: md.trackNumber,
      artist: !md.artist || Array.isArray(md.artist) ? md.artist : [md.artist]
    })
  }

  get albumId () {
    return this.#album?.albumId
  }

  get trackId () {
    return this.albumId ? join(this.albumId, this.file) : undefined
  }

  get url () {
    return this.trackId
      ? new URL(this.trackId, config.libraryRootCifs).href
      : undefined
  }
}

class UnknownTrack extends Track {
  constructor (url) {
    super()
    this.url = url
  }
}

async function * scanDir (dirPath, target = 'metadata.json') {
  const dirents = await readdir(dirPath, { withFileTypes: true })
  for (const dirent of dirents.sort(sortBy('name'))) {
    if (dirent.isFile() && dirent.name === target) {
      yield join(dirPath, dirent.name)
    } else if (dirent.isDirectory()) {
      yield * scanDir(join(dirPath, dirent.name), target)
    }
  }
}
