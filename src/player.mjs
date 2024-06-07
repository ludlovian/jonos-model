import util from 'node:util'
import assert from 'node:assert'

import { batch } from '@preact/signals-core'

import equal from 'pixutil/equal'
import sleep from 'pixutil/sleep'
import Debug from '@ludlovian/debug'
import addSignals from '@ludlovian/signal-extra/add-signals'

import ApiPlayer from 'jonos-api'

import verifyCall from './verify-call.mjs'

export default class Player {
  #players
  #isReady
  #api
  #debug = () => {}

  constructor (players, url, data = {}) {
    this.#players = players
    this.#api = new ApiPlayer(url)
    this.#api
      .on('player', this.updatePlayer.bind(this))
      .on('system', players.updateSystem.bind(players))
      .on('error', this.handleError.bind(this))

    addSignals(this, {
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
      trackMetadata: '',
      error: undefined,
      listening: false,

      // derived
      url: () => this.#api.url.href,
      leader: () => this.#players.byUuid.get(this.leaderUuid) ?? this,
      isLeader: () => this.leader === this,
      hasFollowers: () =>
        this.isLeader
          ? this.#players.groups.get(this).some(p => p !== this)
          : false
    })

    Object.assign(this, data)
    this.#debug = Debug(`jonos-model:Player:${this.name}`)

    this.#debug('Created player %s on %s', this.name, this.url)
  }

  [util.inspect.custom] (depth, opts) {
    if (depth < 0) return opts.stylize('[Player]', 'special')
    return `Player { ${opts.stylize(this.name, 'special')} }`
  }

  get api () {
    return this.#api
  }

  handleError (err) {
    console.error('Player: %s - %o', this.name, err)
    this.error = err
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

  detach () {
    this.#api.removeAllListeners()
  }

  async start () {
    await this.isReady
    await this.update()
  }

  get isReady () {
    if (this.#isReady) return this.#isReady
    this.#isReady = this.#api.startListening()
    this.listening = true
  }

  async stop () {
    if (this.#isReady === undefined) return
    await this.#isReady
    if (this.#isReady === undefined) return
    this.#isReady = undefined
    this.listening = false
    await this.#api.stopListening()
  }

  async update () {
    this.updatePlayer({
      ...(await this.#api.getDescription()),
      ...(await this.#api.getVolume()),
      ...(await this.#api.getMute()),
      ...(await this.#api.getPositionInfo())
    })
  }

  // --------------- Verifying API ---------------

  async joinGroup (leader) {
    await this.isReady
    assert.ok(leader instanceof Player)
    assert.ok(!this.hasFollowers, 'Must not already have followers')
    const fn = () => this.#api.joinGroup(leader.uuid)
    const verify = () => this.leaderUuid === leader.uuid
    const msg = `${this.name} joining group ${leader.name}`
    return verifyCall(fn, verify, msg)
  }

  async startOwnGroup () {
    await this.isReady
    assert.ok(!this.isLeader, 'Must not already be a leader')
    const fn = () => this.#api.startOwnGroup()
    const verify = () => this.isLeader
    const msg = `${this.name} starting own group`
    return verifyCall(fn, verify, msg)
  }

  async setVolume (vol) {
    await this.isReady
    const fn = () => this.#api.setVolume(vol)
    const verify = () => this.volume === vol
    const msg = `Setting volume for ${this.name}`
    return verifyCall(fn, verify, msg)
  }

  async setMute (mute) {
    await this.isReady
    const fn = () => this.#api.setMute(!!mute)
    const verify = () => this.mute === !!mute
    const msg = `Setting mute for ${this.name}`
    return verifyCall(fn, verify, msg)
  }

  async play () {
    await this.isReady
    const fn = () => this.#api.play()
    const verify = () => this.isPlaying
    const msg = `Start play for ${this.name}`
    return verifyCall(fn, verify, msg)
  }

  async pause () {
    await this.isReady
    const fn = () => this.#api.pause()
    const verify = () => !this.isPlaying
    const msg = `Pausing play for ${this.name}`
    return verifyCall(fn, verify, msg)
  }

  // --------------- Play logic ------------------
  async playRadio (url) {
    assert.ok(url.startsWith('x-rincon-mp3radio:'), 'Must be a radio')
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
    await this.#api.setAVTransportURI(`x-rincon-queue:${this.uuid}#0`)
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
    if (mediaUri.startsWith('x-rincon-queue:') && trackNum && trackPos) {
      await this.#api.seekTrack(trackNum)
      await this.#api.seekPos(trackPos)
    }

    if (wasPlaying) await this.#api.play()
  }
}
