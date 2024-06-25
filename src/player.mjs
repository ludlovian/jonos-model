import assert from 'node:assert'
import { setTimeout as sleep } from 'node:timers/promises'
import { batch, effect } from '@preact/signals-core'
import Parsley from '@ludlovian/parsley'
import equal from '@ludlovian/equal'
import Debug from '@ludlovian/debug'
import signalbox from '@ludlovian/signalbox'
import Lock from '@ludlovian/lock'
import ApiPlayer from '@ludlovian/jonos-api'

import { QUEUE, CIFS } from '@ludlovian/jonos-api/constants'
import {
  isValidUrl,
  isValidNowPlaying,
  isValidTrackUrl,
  isValidQueueUrl,
  isValidNotificationUrl
} from './valid.mjs'
import { verifyCallPoll } from './verify-call.mjs'
import config from './config.mjs'

const customInspect = Symbol.for('nodejs.util.inspect.custom')

export default class Player {
  #players
  #startStopLock = new Lock()
  #isReady
  #api
  #debug = () => {}

  constructor (players, url, data = {}) {
    this.#players = players
    this.#api = new ApiPlayer(url)

    this.handleError = this.handleError.bind(this)
    this.updatePlayer = this.updatePlayer.bind(this)

    this.#api
      .on('error', this.handleError)
      .on('AVTransport', this.updatePlayer)
      .on('RenderingControl', this.updatePlayer)
      .on('ZoneGroupTopology', players.updateSystem)

    signalbox(this, {
      // static
      name: () => this.fullName.replaceAll(' ', '').toLowerCase(),
      fullName: 'Unknown',
      uuid: '',
      model: '',

      // variable
      leaderUuid: undefined,
      volume: undefined,
      mute: false,
      playState: '',
      isPlaying: false,
      playMode: '',
      trackUrl: undefined,
      trackDuration: undefined,
      trackMetadata: '',
      trackDetails: undefined,
      error: undefined,
      listening: false,

      // updated by effect - an array of urls currently being played
      queueUrls: undefined,

      // derived
      url: () => this.#api.url.href,
      leader: () => this.#players.byUuid.get(this.leaderUuid),
      isLeader: () => this.leader === this,
      followers: () => (this.isLeader ? this.players.groups.get(this) : [this]),
      hasFollowers: () => this.followers.length > 1,

      // the queue of items currently being played, possibly aggregated into
      // albums, and also including the nowPlaying from radio stations
      queue: () => this.#getQueueFromUrls(),
      media: () => this.#getCurrentMediaItem()
    })

    Object.assign(this, data)
    this.#debug = Debug(`jonos-model:Player:${this.name}`)
    this.#debug('Created player %s on %s', this.name, this.url)

    effect(() => this.#monitorQueueUrls())
  }

  // -------- Inspect and getters -----------------------

  [customInspect] (depth, opts) {
    if (depth < 0) return opts.stylize('[Player]', 'special')
    return `Player { ${opts.stylize(this.name, 'special')} }`
  }

  get library () {
    return this.players.model.library
  }

  get api () {
    return this.#api
  }

  get players () {
    return this.#players
  }

  // -------- Error handling ----------------------------

  handleError (err) {
    console.error('Player: %s - %o', this.name, err)
    this.error = this.error ?? err
  }

  // -------- Reactions and derived attributes ----------

  async #monitorQueueUrls () {
    // effect based calculation of the urls in a players queue
    // It is always null or an array
    // Set to Null if the player is not a leader, has no media loaded, or
    // has some unknown media (transiently) such as the FOLLOW or QUEUE media
    //
    // Otherwise we gather the list of urls currently playing
    //

    if (this.model.error) return
    if (!this.isLeader || !isValidUrl(this.trackUrl)) {
      this.updatePlayer({ queueUrls: null })
      return
    }

    // if we have a queue, and it includes the current track, then we are done
    // This will get tripped up if we change the queue externally, but will
    // sort itself once we hit a url that we don't recognise
    if (this.queueUrls && this.queueUrls.includes(this.trackUrl)) {
      return
    }

    const trackUrl = this.trackUrl

    // so now we get the playlist from the player and set queueUrls

    this.getPlaylist()
      .then(queueUrls => {
        if (trackUrl === this.trackUrl) {
          // only update if it is valid - ie the queue contains
          // the currrent item. If not, we set it to null and try again
          if (queueUrls.includes(trackUrl)) {
            this.updatePlayer({ queueUrls })
          } else {
            this.updatePlayer({ queueUrls: null })
          }
        }
      })
      .catch(this.handleError)
  }

  #getQueueFromUrls () {
    // Takes the existing array of urls int he queue and expands it
    // to a structured list of library items, aggregating
    // tracks into album subsets
    //
    // If the queue url is also the track url, and is a radio
    // then we try to extract the nowPlaying attribute
    if (!this.queueUrls) return null
    const queue = []
    let album
    for (const url of this.queueUrls) {
      const item = this.library.locate(url)
      if (!item) continue

      const itemData = item.toJSON()
      if (item.type === 'track') {
        if (item.album.url !== album?.url) {
          album = { ...item.album.toJSON(), tracks: [itemData] }
          queue.push(album)
        } else {
          album.tracks.push(itemData)
        }
      } else {
        queue.push(itemData)
        if (
          item.type === 'radio' &&
          item.url === this.trackUrl &&
          this.trackMetadata
        ) {
          const elem = Parsley.from(this.trackMetadata.trim(), { safe: true })
          if (elem) {
            const nowPlaying = elem.find('r:streamContent')?.text
            if (isValidNowPlaying(nowPlaying)) {
              itemData.nowPlaying = nowPlaying
            }
          }
        }
      }
    }
    return queue
  }

  #getCurrentMediaItem () {
    if (!this.isLeader || !this.trackUrl || !this.queue) return null

    // simply look for it in the queue
    const found = this.queue.find(item => item.url === this.trackUrl)
    if (found) return found

    // perhaps it is a track inside an album
    for (const album of this.queue) {
      for (const track of album.tracks || []) {
        if (track.url === this.trackUrl) {
          return {
            ...track,
            album: {
              ...album,
              tracks: undefined
            }
          }
        }
      }
    }
    return null
  }

  // -------- Player attribute update -------------------

  updatePlayer (data) {
    if (!data) return
    batch(() => {
      const updated = []
      for (const [key, value] of Object.entries(data)) {
        if (key in this && !equal(this[key], value)) {
          updated.push(key)
          this[key] = value
        }
      }
      if (updated.length) {
        this.#debug(`Updated: ${updated.join(', ')}`)
      }
    })
  }

  async update () {
    // a one-off update of everything. Handy when starting to listen

    this.updatePlayer({
      ...(await this.#api.getDescription()),
      ...(await this.#api.getVolume()),
      ...(await this.#api.getMute()),
      ...(await this.#api.getPositionInfo()),
      ...(await this.#api.getCurrentGroup())
    })
  }

  // -------- Start and stop listening ------------------

  start () {
    return this.#startStopLock.exec(async () => {
      if (this.listening) return
      await this.#api.startListening()
      await this.update()
      this.listening = true
    })
  }

  stop () {
    return this.#startStopLock.exec(async () => {
      if (!this.listening) return
      await this.#api.stopListening()
      this.listening = false
    })
  }

  // --------------- Group Members API -----------

  async getGroup () {
    const byUuid = this.players.byUuid
    const data = await this.#api.getCurrentGroup()
    return {
      leader: byUuid.get(data.leaderUuid),
      members: data.memberUuids.map(uuid => byUuid.get(uuid))
    }
  }

  async joinGroup (leader) {
    assert.ok(leader instanceof Player)
    if (this.hasFollowers) {
      // kick out everyone else
      for (const p of [...this.followers]) {
        if (p !== this) await p.startOwnGroup()
      }
    }

    await this.#api.joinGroup(leader.uuid)

    // now check it
    const data = await verifyCallPoll(async () => {
      const data = await this.#api.getCurrentGroup()
      if (data.leaderUuid === leader.uuid) return data
    }, `Adding ${this.name} to group ${leader.name}`)

    this.updatePlayer(data)
  }

  async startOwnGroup () {
    assert.ok(!this.isLeader, 'Must not already be a leader')

    await this.#api.startOwnGroup()

    const data = await verifyCallPoll(async () => {
      const data = await this.#api.getCurrentGroup()
      if (data.leaderUuid === this.uuid) return data
    }, `${this.name} starting own group`)

    this.updatePlayer(data)
  }

  // --------------- Rendering API ---------------

  async setVolume (vol) {
    await this.#api.setVolume(vol)

    const data = await verifyCallPoll(async () => {
      const data = await this.#api.getVolume()
      if (data.volume === vol) return data
    }, `Setting volume for ${this.name}`)
    this.updatePlayer(data)
  }

  async setMute (mute) {
    mute = !!mute
    await this.#api.setMute(mute)

    const data = await verifyCallPoll(async () => {
      const data = await this.#api.getMute()
      if (data.mute === mute) return data
    }, `Setting mute for ${this.name}`)
    this.updatePlayer(data)
  }

  async play () {
    await this.#api.play()

    const data = await verifyCallPoll(async () => {
      const data = await this.#api.getTransportInfo()
      if (data.isPlaying) return data
    }, `Setting ${this.name} to play`)

    this.updatePlayer(data)
  }

  async pause () {
    await this.#api.pause()

    const data = await verifyCallPoll(async () => {
      const data = await this.#api.getTransportInfo()
      if (data.isPlaying === false) return data
    }, `Setting ${this.name} to pause`)

    this.updatePlayer(data)
  }

  // --------------- Queue and media API ---------

  async getOwnQueue () {
    let result = []
    let from = 0
    while (true) {
      const { queue } = await this.#api.getQueue(from, 100)
      result = [...result, ...queue]
      if (queue.length < 100) return result
      from += 100
    }
  }

  // Generic function that will return an array of the playing
  // urls - which might only be one if we are playing a radio, tv, stream
  // or item outside a Sonos queue.
  //
  // We only cope with player default queues, not named or saved queues
  //
  async getPlaylist () {
    const { mediaUri } = await this.#api.getMediaInfo()

    if (isValidQueueUrl(mediaUri)) {
      return await this.getOwnQueue()
    } else if (isValidUrl(mediaUri)) {
      return [mediaUri]
    } else {
      return []
    }
  }

  // Loads mediaURI and/or queue onto a player, and optionally
  // plays and sets repeat mode
  //
  async loadMedia (urls, opts = {}) {
    assert.ok(this.isLeader, 'Not a leader')
    assert.ok(typeof urls === 'string' || Array.isArray(urls))
    urls = [urls].flat()
    assert.ok(urls.every(url => url && typeof url === 'string'))
    assert.ok(urls.length > 0)

    const { play, repeat, add } = opts
    const isQueue = urls.length > 1 || urls[0].startsWith(CIFS)

    if (isQueue) {
      // we can only play known flac tracks
      assert.ok(urls.every(url => isValidTrackUrl(url)))

      // must be a queue, so ensure we are playing the queue
      const { mediaUri } = await this.#api.getMediaInfo()
      if (!isValidQueueUrl(mediaUri)) {
        await this.#api.setAVTransportURI(`${QUEUE}${this.uuid}#0`)
      }
      if (!add) {
        await this.#api.emptyQueue()
      }

      await this.#api.addUriToQueue(urls.shift())
      if (play) {
        const { isPlaying } = await this.#api.getTransportInfo()
        if (!isPlaying) await this.play()
      }

      // and add the rest of the urls
      for (const url of urls) {
        await this.#api.addUriToQueue(url)
      }
      this.queueUrls = undefined // force a rebuild

      if (repeat !== undefined) {
        await this.#api.setPlayMode(repeat ? 'REPEAT_ALL' : 'NORMAL')
      }
    } else {
      await this.#api.setAVTransportURI(urls[0])
      if (play) {
        const { isPlaying } = await this.#api.getTransportInfo()
        if (!isPlaying) await this.play()
      }
    }
  }

  async copy (player) {
    assert.ok(player instanceof Player)
    const { mediaUri, mediaMetadata } = await player.#api.getMediaInfo()
    if (isValidQueueUrl(mediaUri)) {
      const { playMode } = await player.#api.getPlayMode()
      const { repeat } = PLAYMODES[playMode] ?? {}
      const urls = await player.getOwnQueue()
      this.loadMedia(urls, { repeat })
    } else {
      await this.#api.setAVTransportURI(mediaUri, mediaMetadata)
    }
  }

  // ------------- Higher level command API ------

  async playNotification (url, opts = {}) {
    const { volume, play, delay = config.monitorPollDelay } = opts
    assert.ok(this.isLeader, 'Not a leader')
    assert.ok(isValidNotificationUrl(url), 'Not a URL')

    const isPlaying = async () => (await this.#api.getTransportInfo()).isPlaying
    const wasPlaying = await isPlaying()

    if (wasPlaying) await this.#api.pause()
    const oldVolumes = this.followers.map(p => [p, p.volume])
    if (volume) {
      await Promise.all(this.followers.map(p => p.setVolume(volume)))
    }

    const { trackNum, trackPos } = await this.#api.getPositionInfo()
    const { mediaUri, mediaMetadata } = await this.#api.getMediaInfo()

    await this.#api.setAVTransportURI(url)
    await this.#api.play()

    let playing = false
    while (!playing) {
      playing = await isPlaying()
      if (!playing) await sleep(delay)
    }

    while (playing) {
      playing = await isPlaying()
      if (playing) await sleep(delay)
    }

    await this.#api.setAVTransportURI(mediaUri, mediaMetadata)
    if (mediaUri.startsWith(QUEUE) && trackNum && trackPos) {
      await this.#api.seekTrack(trackNum)
      await this.#api.seekPos(trackPos)
    }

    if (volume) {
      await Promise.all(oldVolumes.map(([p, v]) => p.setVolume(v)))
    }

    if (wasPlaying && play) await this.#api.play()
  }

  async createGroup (volumes) {
    assert.ok(this.name in volumes, 'Player must be in its own group')
    // first make sure I am a leader
    if (!this.isLeader) {
      await this.startOwnGroup()
    }

    // then set all the volumes
    for (const name in volumes) {
      const player = this.players.byName.get(name)
      await player.setVolume(volumes[name])
    }

    // then transfer playing music to me if I'm silent
    if (!this.isPlaying && this.players.active.length) {
      const curr = this.players.active[0]
      await curr.pause()
      await this.copy(curr)
      await this.play()
    }

    // now go through each player and make sure it is in the group
    // or not
    for (const player of this.players.players) {
      if (player.name in volumes) {
        if (player.leader !== this) {
          await player.joinGroup(this)
        }
      } else {
        if (player.leader === this) {
          await player.startOwnGroup()
        }
      }
    }
  }
}

const PLAYMODES = {
  NORMAL: { repeat: false, single: false, shuffle: false },
  REPEAT_ALL: { repeat: true, single: false, shuffle: false },
  REPEAT_ONE: { repeat: true, single: true, shuffle: false },
  SHUFFLE_NOREPEAT: { repeat: false, single: false, shuffle: true },
  SHUFFLE: { repeat: true, single: false, shuffle: true },
  SHUFFLE_REPEAT_ONE: { repeat: true, single: true, shuffle: true }
}
