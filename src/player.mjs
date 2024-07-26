import assert from 'node:assert/strict'
import { setTimeout as sleep } from 'node:timers/promises'
import Parsley from '@ludlovian/parsley'
import Debug from '@ludlovian/debug'
import Lock from '@ludlovian/lock'
import ApiPlayer from '@ludlovian/jonos-api'

import { safeRetry, verify } from './util.mjs'
import { tick } from './notify.mjs'
import { db } from './database.mjs'
import { ensureArray, ensureOpts } from './ensure.mjs'
import { updatePlayer, updateQueue } from './dbapi.mjs'
import config from './config.mjs'

const RADIO = 'x-rincon-mp3radio'
const DIDL = '<DIDL-Lite'

export default class Player {
  #startStopLock = new Lock()
  #api
  #debug
  #enqueueUrls = []

  players
  id
  url
  uuid
  name

  constructor (players, id) {
    this.players = players
    this.id = id

    const sql = 'select name, url, uuid from player where id=$id'
    const rec = db.get(sql, { id })
    this.name = rec.name
    this.url = rec.url
    this.uuid = rec.uuid

    this.#api = new ApiPlayer(this.url)
    this.#api
      .on('AVTransport', this.#onAvTransport.bind(this))
      .on('RenderingControl', this.#onRenderingControl.bind(this))
      .on('error', this.#handleError.bind(this))

    if (id === 1) {
      this.#api.on('ZoneGroupTopology', players.onTopology.bind(players))
    }
    this.#debug = Debug(`jonos-model:${this.name}`)
  }

  // -------- Inspect and getters -----------------------

  get api () {
    return this.#api
  }

  // -------- Error handling ----------------------------

  #handleError (err) {
    console.error('Player: %s - %o', this.name, err)
    // not sure what else we do
  }

  // -------- Event handling ----------------------------

  #onAvTransport (data) {
    const { playState, trackUrl, trackMetadata, playMode } = data
    const parms = { id: this.id, playState, playMode, sonosUrl: trackUrl }

    if (trackUrl?.startsWith(RADIO) && trackMetadata?.trim().startsWith(DIDL)) {
      const elem = Parsley.from(trackMetadata.trim(), { safe: true })
      if (elem) {
        const str = elem.find('r:streamContent')?.text
        if (str && !/^Z[A-Z_]+$/.test(str)) {
          parms.nowPlaying = str
        }
      }
    }

    updatePlayer(parms)
  }

  #onRenderingControl (data) {
    const { volume, mute } = data
    const parms = { id: this.id, volume, mute }
    updatePlayer(parms)
  }

  onLeader ({ leaderUuid }) {
    updatePlayer({ id: this.id, leaderUuid })
  }

  // -------- Player attribute update -------------------

  async updateEverything () {
    const { trackUrl, trackMetadata } = await this.#api.getPositionInfo()
    const { playState } = await this.#api.getTransportInfo()
    const { playMode } = await this.#api.getPlayMode()
    const { volume } = await this.#api.getVolume()
    const { mute } = await this.#api.getMute()
    const { model } = await this.#api.getDescription()
    const { leaderUuid } = await this.#api.getCurrentGroup()

    this.#onAvTransport({ trackUrl, trackMetadata, playState, playMode })
    this.#onRenderingControl({ volume, mute })
    this.onLeader({ leaderUuid })

    const sql = 'update player set model=$model where id=$id'
    db.run(sql, { id: this.id, model })
    tick()
  }

  // -------- Start and stop listening ------------------

  start () {
    return this.#startStopLock.exec(async () => {
      if (this.#api.isListening) return
      await this.#api.startListening()
      await this.updateEverything()
      this.#debug('started listening')
    })
  }

  stop () {
    return this.#startStopLock.exec(async () => {
      if (!this.#api.isListening) return
      await this.#api.stopListening()
      this.#debug('stopped listening')
    })
  }

  // ------------ Tasks --------------------------

  async doTask (cmd, p1, p2) {
    if (p2 != null) {
      this.#debug('%s(%s, %s)', cmd, p1, p2)
    } else if (p1 != null) {
      this.#debug('%s(%s)', cmd, p1)
    } else {
      this.#debug('%s()', cmd)
    }
    switch (cmd) {
      case 'getQueue':
        return safeRetry(() => this.#getQueue())
      case 'setVolume':
        return safeRetry(() => this.#setVolume(+p1))
      case 'setMute':
        return safeRetry(() => this.#setMute(!!p1))
      case 'play':
        return safeRetry(() => this.#playPause(true))
      case 'pause':
        return safeRetry(() => this.#playPause(false))
      case 'startGroup':
        return safeRetry(() => this.#startOwnGroup())
      case 'joinGroup':
        return safeRetry(() => this.#joinGroup(p1))
      case 'enqueue': {
        const opts = { timeout: 3 * config.callTimeout }
        p1 = ensureArray(p1)
        p2 = ensureOpts(p2)
        return safeRetry(() => this.#enqueue(p1, p2), opts)
      }
      case 'loadMedia': {
        const opts = { timeout: 3 * config.callTimeout }
        p2 = ensureOpts(p2)
        return safeRetry(() => this.#loadMedia(p1, p2), opts)
      }
      case 'notify': {
        const opts = { retries: 1, timeout: p2 }
        return safeRetry(() => this.#playNotification(p1), opts)
      }
    }
  }

  // ------------ Queue Monitoring ---------------
  async #getQueue () {
    // updates the `items` column on the `queue` table
    //
    // If we are not playing a queue, we set it to null
    //
    // If we are, we fetch the queue

    const { mediaUri } = await this.#api.getMediaInfo()
    let urls = null
    if (mediaUri.startsWith(ApiPlayer.QUEUE)) {
      urls = []
      for (let i = 0; ; i += 100) {
        const { queue } = await this.#api.getQueue(i, 100)
        urls = [...urls, ...queue]
        if (queue.length < 100) break
      }
    }
    updateQueue({ id: this.id, urls })
  }

  // ------------ Enqueuing Media ----------------

  async #enqueue (urls, opts = {}) {
    const { play, repeat, add } = opts

    const { CIFS, QUEUE } = ApiPlayer
    const isQueue = urls.length > 1 || urls[0].startsWith(CIFS)

    if (isQueue) {
      const { mediaUri } = await this.#api.getMediaInfo()
      if (!mediaUri.startsWith(QUEUE)) {
        await this.#api.setAVTransportURI(`${QUEUE}${this.uuid}#0`)
      }

      // If replacing the queue, rather than adding, we set up the
      // first url in order to set everything going, and then
      // schedule the adds to be done after we return
      //
      if (!add) {
        this.#enqueueUrls = []
        await this.#api.emptyQueue()

        // Just add one and (maybe) start playing
        const url = urls.shift()
        await this.#api.addUriToQueue(url)

        // update the DB and rebuild the new (short) queue
        updatePlayer({ id: this.id, sonosUrl: url })
        await this.#getQueue()

        // set it playing if required, with the right play mode
        if (play) {
          const { isPlaying } = await this.#api.getTransportInfo()
          if (!isPlaying) await this.#playPause(true)
          if (repeat) {
            const playMode = 'REPEAT_ALL'
            await this.#api.setPlayMode(playMode)
            updatePlayer({ id: this.id, playMode })
          }
        }
      }

      // Now we have a bunch of URLs to add to the queue
      // which we do later. If there's not a loader running
      // then we set one going
      //
      if (!urls.length) return

      const bIsLoading = !!this.#enqueueUrls.length
      this.#enqueueUrls.push(...urls)
      if (!bIsLoading) this.#loadUrls()
    } else {
      const url = urls[0]
      if (!url) return
      await this.#api.setAVTransportURI(url)
      updatePlayer({ id: this.id, sonosUrl: url })
      await this.#getQueue()
      if (play) {
        const { isPlaying } = await this.#api.getTransportInfo()
        if (!isPlaying) await this.#playPause(true)
      }
    }
  }

  #loadMedia (url, opts) {
    let sql = 'select type from mediaEx where sonosUrl=$url'
    const type = db.pluck.get(sql, { url })
    if (!type) return
    if (type !== 'track') return this.#enqueue([url], opts)

    sql = `
      select sonosUrl from albumTracks where albumId =
      (select albumId from albumTracks where sonosUrl=$url)
    `
    const urls = db.pluck.all(sql, { url })
    if (urls.length) return this.#enqueue(urls, opts)
  }

  async #loadUrls () {
    // load the Urls onto the queue, asynchronously
    while (this.#enqueueUrls.length) {
      const url = this.#enqueueUrls.shift()
      await safeRetry(() => this.#api.addUriToQueue(url))
    }
    this.doTask('getQueue')
  }

  // ------------ Rendering Control --------------

  async #setVolume (vol) {
    await this.#api.setVolume(vol)
    await verify(async () => {
      const { volume } = await this.#api.getVolume()
      return vol === volume
    })
    updatePlayer({ id: this.id, volume: vol })
  }

  async #setMute (mute) {
    await this.#api.setMute(mute)
    await verify(async () => {
      const { mute: mute_ } = await this.#api.getMute()
      return mute === mute_
    })
    updatePlayer({ id: this.id, mute })
  }

  async #playPause (val) {
    if (val) {
      await this.#api.play()
    } else {
      await this.#api.pause()
    }
    const data = await verify(async () => {
      const res = await this.#api.getTransportInfo()
      return res.isPlaying === !!val ? res : null
    })
    updatePlayer({ id: this.id, playState: data.playState })
  }

  // ------------ Group Management ---------------

  async #startOwnGroup () {
    const data = await this.#api.getCurrentGroup()
    if (data.leaderUuid === this.uuid) return

    await this.#api.startOwnGroup()
    await verify(async () => {
      const data = await this.#api.getCurrentGroup()
      return data.leaderUuid === this.uuid
    })
    this.onLeader({ leaderUuid: this.uuid })
  }

  async #joinGroup (leaderName) {
    const leader = this.players.byName[leaderName]
    assert(leader)

    const data = await this.#api.getCurrentGroup()
    if (data.leaderUuid === this.uuid) {
      const uuids = data.memberUuids.filter(uuid => uuid !== this.uuid)
      for (const uuid of uuids) {
        const follower = this.players.byUuid[uuid]
        if (follower) await follower.#startOwnGroup()
      }
    }

    await this.#api.joinGroup(leader.uuid)

    verify(async () => {
      const data = await this.#api.getCurrentGroup()
      return data.leaderUuid === leader.uuid
    })

    this.onLeader({ leaderUuid: leader.uuid })
  }

  // ------------ Notification playing -----------

  async #playNotification (url) {
    const { QUEUE } = ApiPlayer
    const delay = config.monitorPollDelay

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
