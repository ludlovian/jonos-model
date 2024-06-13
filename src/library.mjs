import { readdir, readFile } from 'node:fs/promises'
import { resolve, dirname, relative, join } from 'node:path'

import sortBy from '@ludlovian/sortby'
import addSignals from '@ludlovian/signal-extra/add-signals'

import config from './config.mjs'

export default class Library {
  constructor () {
    addSignals(this, {
      albums: [],
      albumById: () => new Map(this.albums.map(a => [a.id, a])),

      tracks: () => this.albums.map(a => a.tracks).flat(),
      trackById: () => new Map(this.tracks.map(t => [t.id, t])),
      trackByUrl: () => new Map(this.tracks.map(t => [t.url, t])),

      media: [],
      mediaById: () => new Map(this.media.map(m => [m.id, m])),
      mediaByUrl: () => new Map(this.media.map(m => [m.url, m])),

      wordsToItems: () => this.#wordsToItems(),

      scanning: false
    })
  }

  async scan () {
    this.scanning = true
    this.media = await Media.load()
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
      return this.trackByUrl.get(url)
    } else {
      const urls = [url, url.split(':')[0]]
      for (const url of urls) {
        const media = this.mediaByUrl.get(url)
        if (media) return media
      }
    }
  }

  #wordsToItems (minLength = config.minSearchWord) {
    const wordsToItem = new Map()
    const items = [...this.albums, ...this.media]
    for (const item of items) {
      const words = new Set(
        item.searchText
          .toLowerCase()
          .split(' ')
          .filter(w => w.length >= minLength)
      )

      for (const word of words) {
        linkWordToItem(word, item)
      }
    }

    return wordsToItem

    function linkWordToItem (word, item) {
      let set = wordsToItem.get(word)
      if (!set) wordsToItem.set(word, (set = new Set()))
      set.add(item)
    }
  }

  search (text) {
    const wordsToItems = this.wordsToItems

    const searchWords = new Set(
      text
        .toLowerCase()
        .split(' ')
        .filter(w => w.length >= config.minSearchWord)
    )

    // we must have at least one word of 3 chars or more
    if (!searchWords.size) return []

    // the library of index words
    const allWords = new Set(wordsToItems.keys())

    const found = intersectAll(
      [...searchWords].map(getItemsMatchingPartialWord)
    )

    return [...found]
      .map(({ type, id }) => ({ type, id }))
      .sort(sortBy('type').thenBy('id'))

    function getItemsMatchingPartialWord (partial) {
      const words = [...allWords].filter(w => w.includes(partial))
      return unionAll(words.map(w => wordsToItems.get(w)))
    }

    function unionAll (sets) {
      let result = new Set()
      for (const set of sets) {
        if (set) result = result.union(set)
      }
      return result
    }

    function intersectAll (sets) {
      let result
      for (const set of sets) {
        if (!set) return new Set()
        result = result ? result.intersect(set) : set
      }
      return result
    }
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

  get searchText () {
    return `${this.artist} ${this.title} ${this.genre ?? ''}`
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

class Media {
  id
  type
  url
  artwork
  title

  static async load () {
    const root = resolve(config.mediaRoot)
    const file = join(root, config.mediaFile)
    const md = JSON.parse(await readFile(file, 'utf8'))
    return md.map(md => {
      const m = new Media(md, { root })
      return m
    })
  }

  constructor (data, { root } = {}) {
    const { type, url, id, title, artwork } = data
    Object.assign(this, { type, url, id, title })
    if (root && artwork) this.artwork = join(root, artwork)
  }

  get searchText () {
    return `${this.type} ${this.title}`
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
