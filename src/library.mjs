import { readdir, readFile, writeFile } from 'node:fs/promises'
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

      // derived lookups
      tracks: () => this.albums.map(a => a.tracks).flat(),
      artworkByUrl: () =>
        new Map(
          [...this.albums, ...this.tracks, ...this.media]
            .filter(x => x.artwork)
            .map(x => [x.url, x.artwork])
        ),
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
    this.albums = []
    this.media = await Media.loadFromFile(this)
    const root = resolve(config.libraryRoot)
    this.albums = await Album.loadFromDir(this, root)
    this.scanning = false
  }

  async loadFromStore () {
    const file = join(config.mediaRoot, 'library.json')
    const data = JSON.parse(await readFile(file, 'utf8'))
    this.media = data.media.map(m => new Media(this, m))
    this.albums = data.albums.map(data => {
      const album = new Album(this, data)
      album.tracks = data.tracks.map(t => new Track(album, t))
      return album
    })
  }

  async writeToStore () {
    const media = this.media.map(media => ({ ...media }))
    const albums = this.albums.map(album => ({
      ...album,
      genre: album.genre,
      tracks: album.tracks.map(t => ({ ...t }))
    }))
    const file = join(config.mediaRoot, 'library.json')
    const data = { media, albums }
    await writeFile(file, JSON.stringify(data, null, 2))
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
  artwork
  // private attributes not used yet
  #genre

  static async loadFromDir (library, root) {
    const albums = []
    for await (const mdFile of scanDir(root)) {
      albums.push(await Album.fromMetadata(mdFile, { root, library }))
    }
    return albums.sort(sortBy('artist').thenBy('title'))
  }

  static async fromMetadata (mdFile, { root, library }) {
    const md = JSON.parse(await readFile(mdFile, 'utf8'))
    const dir = dirname(mdFile)
    const relDir = relative(root, dir)
    const url = new URL(relDir + '/', config.libraryRootCifs).href
    const album = new Album(library, {
      url,
      artist: md.albumArtist,
      title: md.album,
      genre: md.genre,
      artwork: join(dir, 'cover.jpg')
    })
    album.tracks = md.tracks.map(
      t =>
        new Track(album, {
          url: new URL(t.file, album.url).href,
          title: t.title
        })
    )
    return album
  }

  constructor (library, data) {
    this.#library = library
    this.url = data.url
    this.artist = data.artist
    this.title = data.title
    this.#genre = data.genre
    this.artwork = data.artwork
  }

  get library () {
    return this.#library
  }

  get searchText () {
    return `${this.artist} ${this.title} ${this.#genre ?? ''}`
  }

  get genre () {
    return this.#genre
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

  constructor (album, data) {
    this.#album = album
    this.url = data.url
    this.title = data.title
  }

  get album () {
    return this.#album
  }

  get library () {
    return this.album.library
  }

  get artwork () {
    return this.album.artwork
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
  artwork

  static async loadFromFile (library) {
    const root = resolve(config.mediaRoot)
    const file = join(root, config.mediaFile)
    const md = JSON.parse(await readFile(file, 'utf8'))
    return md.map(
      md =>
        new Media(library, {
          ...md,
          artwork: md.artwork && join(root, md.artwork)
        })
    )
  }

  constructor (library, data) {
    this.#library = library
    this.url = data.url
    this.title = data.title
    this.type = data.type
    this.artwork = data.artwork
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
