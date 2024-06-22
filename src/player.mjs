import assert from 'node:assert'
import { setTimeout as sleep } from 'node:timers/promises'
import { batch } from '@preact/signals-core'
import Parsley from '@ludlovian/parsley'
import equal from '@ludlovian/equal'
import Debug from '@ludlovian/debug'
import signalbox from '@ludlovian/signalbox'
import Lock from '@ludlovian/lock'
import ApiPlayer from '@ludlovian/jonos-api'
import { RADIO, QUEUE, CIFS, WEB } from '@ludlovian/jonos-api/constants'

import { verifyCallPoll } from './verify-call.mjs'

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
      followers: () => (this.isLeader ? this.players.groups.get(this) : [this]),
      hasFollowers: () => this.followers.length > 1,
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

  // --------------- Group Members API -----------

  async getGroup () {
    const { leaderUuid, memberUuids } = await this.#api.getCurrentGroup()
    const byUuid = this.players.byUuid
    return {
      leader: byUuid.get(leaderUuid),
      members: memberUuids.map(uuid => byUuid.get(uuid))
    }
  }

  async joinGroup (leader, delay = 500) {
    await this.start()
    assert.ok(leader instanceof Player)
    if (this.hasFollowers) {
      // kick out everyone else
      for (const p of [...this.followers]) {
        if (p !== this) await p.startOwnGroup()
      }
    }

    await this.#api.joinGroup(leader.uuid)

    // now check it
    await verifyCallPoll(
      () => this.getGroup().then(data => data.leader === leader),
      `Adding ${this.name} to group ${leader.name}`
    )
    this.leaderUuid = leader.uuid
  }

  async startOwnGroup () {
    await this.start()
    assert.ok(!this.isLeader, 'Must not already be a leader')

    await this.#api.startOwnGroup()

    await verifyCallPoll(
      () => this.getGroup().then(data => data.leader === this),
      `${this.name} starting own group`
    )

    this.leaderUuid = ''
  }

  // --------------- Rendering API ---------------

  async setVolume (vol) {
    await this.start()

    await this.#api.setVolume(vol)

    await verifyCallPoll(
      () => this.#api.getVolume().then(d => d.volume === vol),
      `Setting volume for ${this.name}`
    )
    this.volume = vol
  }

  async setMute (mute) {
    mute = !!mute
    await this.start()
    await this.#api.setMute(mute)

    await verifyCallPoll(
      () => this.#api.getMute().then(d => d.mute === mute),
      `Setting mute for ${this.name}`
    )
    this.mute = mute
  }

  async play () {
    await this.start()
    await this.#api.play()

    await verifyCallPoll(async () => {
      const d = await this.#api.getTransportInfo()
      if (d.isPlaying) {
        this.playState = d.playState
        return true
      }
    }, `Setting ${this.name} to play`)
  }

  async pause () {
    await this.start()

    await this.#api.pause()

    await verifyCallPoll(async () => {
      const d = await this.#api.getTransportInfo()
      if ('isPlaying' in d && !d.isPlaying) {
        this.playState = d.playState
        return true
      }
    }, `Setting ${this.name} to pause`)
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
  // items - which might only be one if we are playing a radio, tv, stream
  // or item outside a Sonos queue.
  //
  // We only cope with player default queues, not named or saved queues
  //
  async getPlaylist () {
    const { mediaUri } = await this.#api.getMediaInfo()
    const out = {}
    if (!mediaUri) return { items: [] }
    if (mediaUri.startsWith(QUEUE)) {
      const items = await this.getOwnQueue()
      out.items = items
      const { trackNum, trackPos } = await this.#api.getPositionInfo()
      out.index = trackNum - 1
      out.pos = trackPos
    } else {
      out.items = [mediaUri]
    }
    const { playMode } = await this.#api.getPlayMode()
    Object.assign(out, { playMode }, PLAYMODES[playMode] ?? {})
    return out
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
      const isValidTrack = url => url.startsWith(CIFS) && url.endsWith('.flac')
      assert.ok(urls.every(url => isValidTrack(url)))

      // must be a queue, so ensure we are playing the queue
      const { mediaUri } = await this.#api.getMediaInfo()
      if (!mediaUri || !mediaUri.startsWith(QUEUE)) {
        await this.#api.setAVTransportURI(`${QUEUE}${this.uuid}#0`)
      }
      if (!add) await this.#api.emptyQueue()
      await this.#api.addUriToQueue(urls.shift())
      if (play) {
        const { isPlaying } = await this.#api.getTransportInfo()
        if (!isPlaying) await this.#api.play()
      }

      // and add the rest of the urls
      for (const url of urls) {
        await this.#api.addUriToQueue(url)
      }
      if (repeat !== undefined) {
        await this.#api.setPlayMode(repeat ? 'REPEAT_ALL' : 'NORMAL')
      }
    } else {
      await this.#api.setAVTransportURI(urls[0])
      if (play) {
        const { isPlaying } = await this.#api.getTransportInfo()
        if (!isPlaying) await this.#api.play()
      }
    }
  }

  async copy (player) {
    assert.ok(player instanceof Player)
    const { mediaUri, mediaMetadata } = await player.#api.getMediaInfo()
    if (mediaUri.startsWith(QUEUE)) {
      const { playMode } = await player.#api.getPlayMode()
      const { repeat } = PLAYMODES[playMode] ?? {}
      const urls = await player.getOwnQueue()
      this.loadMedia(urls, { repeat })
    } else {
      await this.#api.setAVTransportURI(mediaUri, mediaMetadata)
    }
  }

  async playNotification (url, { volume, play, delay = 1000 } = {}) {
    assert.ok(this.isLeader, 'Not a leader')
    assert.ok(url.startsWith(WEB) || url.startsWith(CIFS), 'Not a URL')

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
