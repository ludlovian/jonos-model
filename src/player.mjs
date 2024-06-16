import assert from 'node:assert'
import { setTimeout as sleep } from 'node:timers/promises'

import { batch } from '@preact/signals-core'

import Parsley from '@ludlovian/parsley'
import equal from '@ludlovian/equal'
import Debug from '@ludlovian/debug'
import signalbox from '@ludlovian/signalbox'
import Lock from '@ludlovian/lock'
import ApiPlayer from '@ludlovian/jonos-api'
import { RADIO, QUEUE } from '@ludlovian/jonos-api/constants'

import verifyCall from './verify-call.mjs'

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
    this.#api
      .on('error', this.handleError.bind(this))
      .on('AVTransport', this.updatePlayer.bind(this))
      .on('RenderingControl', this.updatePlayer.bind(this))
      .on('ZoneGroupTopology', players.updateSystem.bind(players))

    signalbox(this, {
      // static
      name: () => this.fullName.replaceAll(' ', '').toLowerCase(),
      fullName: 'Unknown',
      uuid: '',
      model: '',

      // variable
      leaderUuid: '',
      volume: undefined,
      mute: false,
      playState: '',
      isPlaying: false,
      playMode: '',
      trackUri: '',
      trackDuration: undefined,
      trackMetadata: '',
      trackDetails: undefined,
      error: undefined,
      listening: false,

      // derived
      url: () => this.#api.url.href,
      leader: () => this.#players.byUuid.get(this.leaderUuid) ?? this,
      isLeader: () => this.leader === this,
      hasFollowers: () =>
        this.isLeader
          ? this.#players.groups.get(this).some(p => p !== this)
          : false,
      media: () => this.#getMediaFromUrl(this.trackUri)
    })

    Object.assign(this, data)
    this.#debug = Debug(`jonos-model:Player:${this.name}`)

    this.#debug('Created player %s on %s', this.name, this.url)
  }

  [customInspect] (depth, opts) {
    if (depth < 0) return opts.stylize('[Player]', 'special')
    return `Player { ${opts.stylize(this.name, 'special')} }`
  }

  get api () {
    return this.#api
  }

  get players () {
    return this.#players
  }

  handleError (err) {
    console.error('Player: %s - %o', this.name, err)
    this.error = this.error ?? err
  }

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

  async update () {
    this.updatePlayer({
      ...(await this.#api.getDescription()),
      ...(await this.#api.getVolume()),
      ...(await this.#api.getMute()),
      ...(await this.#api.getPositionInfo())
    })
  }

  #getMediaFromUrl (url) {
    const library = this.players.model.library
    if (!url) return undefined
    const media = library.locate(url)?.toJSON()
    // if this is also the one we are playing AND
    // it is a radio, then extract the 'now' value
    if (
      media &&
      url === this.trackUri &&
      url.startsWith(RADIO) &&
      this.trackMetadata
    ) {
      const p = Parsley.from(this.trackMetadata.trim(), { safe: true })
      if (p) {
        const now = p.find('r:streamContent')?.text
        if (now != null) media.now = now
      }
    }
    return media
  }

  // --------------- Compound get logic ----------

  async getPlaylist () {
    // if we aren't a leader then return nothing
    if (!this.isLeader) return {}

    const { mediaUri } = await this.api.getMediaInfo()
    // not playing anything
    if (!mediaUri) return {}

    // not a queue, so we are just playing one thing
    if (!mediaUri.startsWith(QUEUE)) {
      return {
        index: 0,
        items: [this.#getMediaFromUrl(mediaUri) ?? {}]
      }
    }
    const { queue } = await this.api.getQueue()
    const { trackNum } = await this.api.getPositionInfo()
    return {
      index: trackNum - 1,
      items: queue.map(url => this.#getMediaFromUrl(url))
    }
  }

  // --------------- Verifying API ---------------

  async joinGroup (leader) {
    await this.start()
    assert.ok(leader instanceof Player)
    assert.ok(!this.hasFollowers, 'Must not already have followers')
    const fn = () => this.#api.joinGroup(leader.uuid)
    const verify = () => this.leaderUuid === leader.uuid
    const msg = `${this.name} joining group ${leader.name}`
    return verifyCall(fn, verify, msg)
  }

  async startOwnGroup () {
    await this.start()
    assert.ok(!this.isLeader, 'Must not already be a leader')
    const fn = () => this.#api.startOwnGroup()
    const verify = () => this.isLeader
    const msg = `${this.name} starting own group`
    return verifyCall(fn, verify, msg)
  }

  async setVolume (vol) {
    await this.start()
    const fn = () => this.#api.setVolume(vol)
    const verify = () => this.volume === vol
    const msg = `Setting volume for ${this.name}`
    return verifyCall(fn, verify, msg)
  }

  async setMute (mute) {
    await this.start()
    const fn = () => this.#api.setMute(!!mute)
    const verify = () => this.mute === !!mute
    const msg = `Setting mute for ${this.name}`
    return verifyCall(fn, verify, msg)
  }

  async play () {
    await this.start()
    const fn = () => this.#api.play()
    const verify = () => this.isPlaying
    const msg = `Start play for ${this.name}`
    return verifyCall(fn, verify, msg)
  }

  async pause () {
    await this.start()
    const fn = () => this.#api.pause()
    const verify = () => !this.isPlaying
    const msg = `Pausing play for ${this.name}`
    return verifyCall(fn, verify, msg)
  }

  // --------------- Play logic ------------------
  async playRadio (url) {
    assert.ok(url.startsWith(RADIO), 'Must be a radio')
    await this.#api.setAVTransportURI(url)
    const { isPlaying } = await this.#api.getTransportInfo()
    if (!isPlaying) await this.#api.play()
  }

  async playStream (url) {
    await this.#api.setAVTransportURI(url)
    const { isPlaying } = await this.#api.getTransportInfo()
    if (!isPlaying) await this.#api.play()
  }

  async playQueue (urls, repeat = false) {
    assert.ok(urls.length, 'Must supply an array of urls')
    await this.#api.emptyQueue()
    await this.#api.addUriToQueue(urls.shift())

    // Now switch to queue and start playing
    await this.#api.setAVTransportURI(`${QUEUE}${this.uuid}#0`)
    const { isPlaying } = await this.#api.getTransportInfo()
    if (!isPlaying) await this.#api.play()

    // and add the rest of the urls
    for (const url of urls) {
      await this.#api.addUriToQueue(url)
    }

    await this.#api.setPlayMode(repeat ? 'REPEAT_ALL' : 'NORMAL')
  }

  async playNotification (url, delay = 1000) {
    const isPlaying = async () => (await this.#api.getTransportInfo()).isPlaying
    const wasPlaying = await isPlaying()

    if (wasPlaying) await this.#api.pause()

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

    if (wasPlaying) await this.#api.play()
  }
}
