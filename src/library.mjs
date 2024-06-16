import { readdir, readFile } from 'node:fs/promises'
import { resolve, dirname, relative, join } from 'node:path'

import sortBy from '@ludlovian/sortby'
import signalbox from '@ludlovian/signalbox'

import config from './config.mjs'

export default class Library {
  #model
  constructor (model) {
    this.#model = model
    signalbox(this, {
      // actual data
      scanning: false,
      albums: [],
      media: [],
      artworkByUrl: new Map(),

      // derived lookups
      tracks: () => this.albums.map(a => a.tracks).flat(),
      mediaByUrl: () =>
        new Map([
          ...this.albums.map(a => [a.url, a]),
          ...this.tracks.map(t => [t.url, t]),
          ...this.media.map(m => [m.url, m])
        ]),

      wordsToMedia: () => this.#wordsToMedia()
    })
  }

  async scan () {
    this.scanning = true
    this.media = await Media.load()
    this.albums = []
    const root = resolve(config.libraryRoot)
    for await (const mdFile of scanDir(root)) {
      const album = await Album.read(mdFile, { root, library: this })
      this.albums = [...this.albums, album]
    }
    this.albums = this.albums.sort(sortBy('artist').thenBy('title'))
    this.scanning = false
  }

  locate (url) {
    for (const key of [url, upToColon(url)]) {
      const media = this.mediaByUrl.get(key)
      if (media) return media
    }

    function upToColon (s) {
      const ix = s.indexOf(':')
      return ix < 0 ? s : s.slice(0, ix + 1)
    }
  }

  #wordsToMedia (minLength = config.minSearchWord) {
    const wordsToMedia = new Map()
    const items = [...this.albums, ...this.media]
    for (const item of items) {
      const words = new Set(
        item.searchText
          .toLowerCase()
          .split(' ')
          .filter(w => w.length >= minLength)
      )

      for (const word of words) {
        let set = wordsToMedia.get(word)
        if (!set) wordsToMedia.set(word, (set = new Set()))
        set.add(item)
      }
    }

    return wordsToMedia
  }

  search (text) {
    const wordsToMedia = this.wordsToMedia

    const searchWords = new Set(
      text
        .toLowerCase()
        .split(' ')
        .filter(w => w.length >= config.minSearchWord)
    )

    // we must have at least one word of 3 chars or more
    if (!searchWords.size) return []

    // the library of index words
    const allWords = [...wordsToMedia.keys()]

    // check each search word in turn, and find the intersection
    // of media items
    let result
    for (const partialWord of searchWords) {
      const matchingWords = allWords.filter(w => w.includes(partialWord))
      let matchingItems = new Set()
      for (const word of matchingWords) {
        const items = wordsToMedia.get(word)
        matchingItems = matchingItems.union(items)
      }
      result = result ? result.intersection(matchingItems) : matchingItems
    }
    return [...result].sort(sortBy('url'))
  }
}

// Album
//
// Represents a logical collection of tracks from the local
// library
//
// URL is the sonos directory (with trailing slash)

class Album {
  // parent link
  #library
  // public attributes
  url
  artist
  title
  tracks
  // private attributes not used yet
  #genre

  static async read (mdFile, { root, library }) {
    const md = JSON.parse(await readFile(mdFile, 'utf8'))
    const dir = dirname(mdFile)
    return new Album(md, { root, dir, library })
  }

  constructor (md, { root, dir, library }) {
    this.#library = library
    const relDir = relative(root, dir)
    this.url = new URL(relDir + '/', config.libraryRootCifs).href
    this.artist = md.albumArtist
    this.title = md.album
    this.#genre = md.genre
    this.library.artworkByUrl.set(this.url, join(dir, 'cover.jpg'))
    this.tracks = (md.tracks ?? [])
      .sort(sortBy('discNumber').thenBy('trackNumber'))
      .map((trackMD, index) => new Track(trackMD, { album: this, index }))
  }

  get library () {
    return this.#library
  }

  get artwork () {
    return this.library.artworkByUrl.get(this.url)
  }

  get searchText () {
    return `${this.artist} ${this.title} ${this.#genre ?? ''}`
  }

  toJSON () {
    return {
      ...this,
      type: this.type,
      tracks: this.tracks.map(t => t.toJSON())
    }
  }

  get type () {
    return 'album'
  }
}

// Track
// Represents a library track
// Idenitfied by the Sonos URL

class Track {
  // link to parent
  #album
  // public attributes
  url
  title

  // private attributes not used (yet)
  #index
  #file
  #discNumber
  #trackNumber
  #artists // array
  #artist // string or undefined

  constructor (md, { album, index }) {
    this.url = new URL(md.file, album.url).href
    this.title = md.title
    this.#album = album
    this.#file = md.file
    this.#index = index
    this.#discNumber = md.discNumber
    this.#trackNumber = md.trackNumber
    this.#artists = [md.artist ?? []].flat()
    this.library.artworkByUrl.set(this.url, this.album.artwork)
  }

  get album () {
    return this.#album
  }

  get library () {
    return this.album.library
  }

  get artwork () {
    return this.library.artworkByUrl.get(this.url)
  }

  toJSON () {
    return { ...this, type: this.type }
  }

  get type () {
    return 'track'
  }
}

// Media
// Represents media other than track or albums
// This could be:
// - radio
// - TV
// - webstream
//
// URI is the sonos version, or simply the protocol

class Media {
  #library
  url
  title
  type

  static async load (library) {
    const root = resolve(config.mediaRoot)
    const file = join(root, config.mediaFile)
    const md = JSON.parse(await readFile(file, 'utf8'))
    return md.map(md => {
      const m = new Media(md, { root, library })
      return m
    })
  }

  constructor (data, { root, library } = {}) {
    this.#library = library
    this.url = data.url
    this.title = data.title
    this.type = data.type
    if (root && data.artwork && library) {
      library.artworkByUrl.set(this.url, join(root, data.artwork))
    }
  }

  get library () {
    return this.#library
  }

  get searchText () {
    return `${this.type} ${this.title}`
  }

  toJSON () {
    return { ...this, type: this.type }
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
