import { readdir, readFile } from 'node:fs/promises'
import { resolve, dirname, relative, join } from 'node:path'

import sortBy from 'sortby'
import addSignals from '@ludlovian/signal-extra/add-signals'

import config from './config.mjs'

export default class Library {
  constructor () {
    addSignals(this, {
      albums: [],
      albumById: () => new Map(this.albums.map(a => [a.id, a])),
      trackByUrl: () =>
        new Map(
          this.albums
            .map(a => a.tracks)
            .flat()
            .map(t => [t.url, t])
        ),

      radio: [],
      radioById: () => new Map(this.radio.map(r => [r.id, r])),
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
      const album = await Album.read(mdFile, rootDir)
      this.albums = [...this.albums, album]
    }
    this.albums = this.albums.sort(sortBy('artist').thenBy('title'))
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

  search (text) {
    const words = text
      .split(' ')
      .map(w => (w ? w.toLowerCase().trim() : w))
      .filter(Boolean)
    // we must have at least one word of 3 chars or more
    if (!words.filter(w => w.length > 2).length) return []

    const universe = [
      ...this.radio.map(radio => ({
        item: radio,
        text: `radio ${radio.title}`.toLowerCase()
      })),
      ...this.albums.map(album => ({
        item: album,
        text: [album.artist, album.title, album.genre ?? '']
          .join(' ')
          .toLowerCase()
      }))
    ]

    return universe
      .filter(({ text }) => words.every(word => text.includes(word)))
      .map(({ item }) => ({ type: item.type, id: item.id }))
  }
}

class Album {
  root
  id
  artist
  genre
  title
  tracks

  static async read (mdFile, root) {
    const md = JSON.parse(await readFile(mdFile, 'utf8'))
    const dir = dirname(mdFile)
    return new Album(md, { root, dir })
  }

  constructor (md, { root, dir }) {
    this.root = root
    this.id = relative(root, dir)
    this.artist = md.albumArtist
    this.genre = md.genre
    this.title = md.album
    this.tracks = (md.tracks ?? [])
      .sort(sortBy('discNumber').thenBy('trackNumber'))
      .map((trackMD, index) => new Track(trackMD, { album: this, index }))
  }

  get type () {
    return 'album'
  }

  get dir () {
    return join(this.root, this.id)
  }

  get artwork () {
    return join(this.root, this.id, 'cover.jpg')
  }

  get url () {
    return new URL(this.id, config.libraryRootCifs).href
  }
}

class Track {
  #album
  index
  #file
  title
  discNumber
  trackNumber
  artist

  constructor (md, { album, index }) {
    this.#album = album
    this.#file = md.file
    this.index = index
    this.title = md.title
    this.discNumber = md.discNumber
    this.trackNumber = md.trackNumber
    if (md.artist) {
      if (Array.isArray(md.artist)) {
        this.artist = md.artist
      } else {
        this.artist = [md.artist]
      }
    }
  }

  get type () {
    return 'track'
  }

  get id () {
    return join(this.album.id, this.#file)
  }

  get album () {
    return this.#album
  }

  get file () {
    return join(this.album.dir, this.#file)
  }

  get url () {
    return new URL(this.id, config.libraryRootCifs).href
  }

  get artwork () {
    return this.album.artwork
  }
}

class UnknownTrack {
  constructor (url) {
    this.url = url
    this.type = 'track'
  }
}

class Radio {
  id
  url
  artwork
  title

  static async load () {
    const root = resolve(config.radioRoot)
    const file = join(root, config.radioFile)
    const md = JSON.parse(await readFile(file, 'utf8'))
    return md.map(md => {
      const r = new Radio(md, { root })
      return r
    })
  }

  constructor (data, { root } = {}) {
    const { url, id, title, artwork } = data
    Object.assign(this, { url, id, title })
    if (root && artwork) this.artwork = join(root, artwork)
  }

  get type () {
    return 'radio'
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
