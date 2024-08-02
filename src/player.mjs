import assert from 'node:assert/strict'
import { setTimeout as sleep } from 'node:timers/promises'
import Debug from '@ludlovian/debug'
import Lock from '@ludlovian/lock'
import ApiPlayer from '@ludlovian/jonos-api'

import { retry, safeRetry, verify, xmlToObject } from './util.mjs'
import { tick } from './notify.mjs'
import { db } from './database.mjs'
import config from './config.mjs'

export default class Player {
  #startStopLock = new Lock()
  #api
  #debug
  #enqueueUrls = []
  #commander = false

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

  // -------- Post construction initialisation ----------

  async updateModel () {
    const { model } = await this.#api.getDescription()
    const sql = 'update player set model=$model where id=$id'
    db.run(sql, { id: this.id, model })
  }

  // -------- Inspect and getters -----------------------

  get api () {
    return this.#api
  }

  get isListening () {
    return this.#api.isListening
  }

  // -------- Error handling ----------------------------

  #handleError (err) {
    console.error('Player: %s - %o', this.name, err)
    // not sure what else we do
  }

  // -------- Event handling ----------------------------

  #onAvTransport (data) {
    const sql = `
      insert into updatePlayer(id,playState,playMode,url,metadata)
      values($id,$playState,$playMode,$url,$metadata)
    `
    const parms = {
      id: this.id,
      // if the url has been given then we set nullish ones to ''
      // to register "no media loaded"
      url: 'trackUrl' in data ? data.trackUrl ?? '' : null,
      playState: data.playState ?? null,
      playMode: data.playMode ?? null
    }
    parms.metadata = xmlToObject(data.trackMetadata)
    if (parms.metadata) parms.metadata = JSON.stringify(parms.metadata)
    db.run(sql, parms)
    tick()
    this.checkActions()
  }

  #onRenderingControl (data) {
    const sql = `
      insert into updatePlayer(id,volume,mute)
      values($id,$volume,$mute)
    `
    const parms = {
      id: this.id,
      volume: data.volume === undefined ? null : data.volume,
      mute: data.mute === undefined ? null : data.mute ? 1 : 0
    }
    db.run(sql, parms)
    tick()
  }

  #onLeader (data) {
    const sql = `
      insert into updatePlayer(id,leaderUuid)
      values($id,$leaderUuid)
    `
    const parms = {
      id: this.id,
      leaderUuid: data.leaderUuid
    }
    db.run(sql, parms)
    tick()
    this.checkActions()
  }

  // -------- Player attribute update -------------------

  async updateLeader () {
    await safeRetry(async () =>
      this.#onLeader(await this.#api.getCurrentGroup())
    )
  }

  async updateAvTransport () {
    await safeRetry(async () =>
      this.#onAvTransport(await this.#api.getPositionInfo())
    )
    await safeRetry(async () =>
      this.#onAvTransport(await this.#api.getTransportInfo())
    )
    await safeRetry(async () =>
      this.#onAvTransport(await this.#api.getPlayMode())
    )
  }

  async updateRendering () {
    await safeRetry(async () =>
      this.#onRenderingControl(await this.#api.getVolume())
    )
    await safeRetry(async () =>
      this.#onRenderingControl(await this.#api.getMute())
    )
  }

  async updateEverything () {
    await this.updateLeader()
    await this.updateAvTransport()
    await this.updateRendering()
  }

  // -------- Start and stop listening ------------------

  start () {
    return this.#startStopLock.exec(async () => {
      if (this.isListening) return
      await this.#api.startListening()
      await this.updateEverything()
      this.#debug('started listening')
    })
  }

  stop () {
    return this.#startStopLock.exec(async () => {
      if (!this.isListening) return
      await this.#api.stopListening()
      this.#debug('stopped listening')
    })
  }

  // ------------ Commands -----------------------

  checkActions () {
    const { id } = this
    let sql = 'select cmd from playerActionsNeeded where id=$id'
    const cmd = db.pluck.get(sql, { id })
    if (!cmd) return
    sql = 'select 1 from command where cmd=$cmd and player=$id'
    if (db.get(sql, { id, cmd })) return
    sql = 'insert into command(player,cmd) values($id,$cmd)'
    db.run(sql, { id, cmd })
    this.checkCommands()
  }

  checkCommands () {
    if (this.#commander) return
    this.#commander = true
    Promise.resolve().then(this.#runCommander())
  }

  async #runCommander () {
    while (true) {
      let sql =
        'select id, cmd, parms from command where player=$id order by id'
      const rec = db.get(sql, { id: this.id })
      if (!rec) break
      sql = 'delete from command where id=$id'
      if (!this[rec.cmd]) {
        console.error('Cannot perform command:', rec)
        db.run(sql, { id: rec.id })
        continue
      }
      this.#debug('run %s(%s)', rec.cmd, rec.parms)
      let parms = rec.parms
      if (
        typeof parms === 'string' &&
        (parms.startsWith('{') || parms.startsWith('['))
      ) {
        try {
          parms = JSON.parse(parms)
        } catch (err) {
          // do nothing
        }
      }
      try {
        await this[rec.cmd](parms)
      } catch (err) {
        console.error('Error when carrying out:', rec)
        console.error(err)
      }
      db.run(sql, { id: rec.id })
    }
    this.#commander = false
  }

  // ------------ Queue Monitoring ---------------
  async getQueue () {
    // updates the `items` column on the `queue` table
    //
    // If we are not playing a queue, we set it to null
    //
    // If we are, we fetch the queue

    const { mediaUri } = await retry(() => this.#api.getMediaInfo())
    let urls = null
    if (mediaUri && mediaUri.startsWith(ApiPlayer.QUEUE)) {
      urls = []
      for (let i = 0; ; i += 100) {
        const fn = () => this.#api.getQueue(i, 100)
        const { queue } = await retry(fn)
        urls = [...urls, ...queue]
        if (queue.length < 100) break
      }
      urls = JSON.stringify(urls)
    }
    const sql = 'insert into updatePlayer (id, queue) values ($id, $urls)'
    urls = urls ?? ''
    db.run(sql, { id: this.id, urls })
    tick()
  }

  // ------------ Enqueuing Media ----------------

  async enqueue (url) {
    await retry(() => this.#api.addUriToQueue(url))
  }

  async loadUrls ({ urls, add, play, repeat }) {
    const { CIFS, QUEUE } = ApiPlayer
    const isQueue = urls.length > 1 || urls[0].startsWith(CIFS)

    // deal with the simpler non-queue version first
    if (!isQueue) {
      const url = urls[0]
      if (!url) return
      await retry(() => this.#api.setAVTransportURI(url))
      const sql = 'insert into updatePlayer(id, url) values($id, $url)'
      db.run(sql, { id: this.id, url })
      tick()
      if (play) await this.play()
      return
    }

    const { mediaUri } = await retry(() => this.#api.getMediaInfo())
    if (!mediaUri.startsWith(QUEUE)) {
      const uri = `${QUEUE}${this.uuid}#0`
      await retry(() => this.#api.setAVTransportURI(uri))
    }

    // If replacing the queue, rather than adding, we set up the
    // first url in order to set everything going, and then
    // schedule the adds to be done after we return
    //
    if (!add) {
      await retry(() => this.#api.emptyQueue())

      // Just add one and (maybe) start playing
      const url = urls.shift()
      await this.enqueue(url)
      const sql = 'insert into updatePlayer(id, url) values($id, $url)'
      db.run(sql, { id: this.id, url })
      tick()
      await this.getQueue()

      if (play) {
        const { isPlaying } = await retry(() => this.#api.getTransportInfo())
        if (!isPlaying) await this.#playPause(true)
        if (repeat) {
          const playMode = 'REPEAT_ALL'
          await retry(() => this.#api.setPlayMode(playMode))
          const sql =
            'insert into updatePlayer(id,playMode) values($id,$playMode)'
          db.run(sql, { id: this.id, playMode })
          tick()
        }
      }
    }

    // Now we have a bunch of URLs to add to the queue, so we
    // add commands to enqueue these, and make sure a commander
    // is running
    if (!urls.length) return

    for (const url of urls) {
      const sql =
        'insert into command(player,cmd,parms) values($id,$cmd,$parms)'
      db.run(sql, { id: this.id, cmd: 'enqueue', parms: url })
    }
    const sql = 'insert into command(player,cmd) values($id,$cmd)'
    db.run(sql, { id: this.id, cmd: 'getQueue' })
    this.checkCommands()
  }

  loadMedia ({ url, ...opts }) {
    // if the url given is a track, then we load all the tracks
    // in the album. Otherwise we just load that one url
    let sql = 'select albumId from track where url=$url'
    const albumId = db.pluck.get(sql, { url })
    if (!albumId) {
      return this.loadUrls({ urls: [url], ...opts })
    }
    sql = 'select url from track where albumId=$albumId order by seq'
    const urls = db.pluck.all(sql, { albumId })
    return this.loadUrls({ urls, ...opts })
  }

  // ------------ Rendering Control --------------

  async setVolume (vol) {
    await retry(() => this.#api.setVolume(vol))
    const bOk = await verify(async () => {
      const { volume } = await this.#api.getVolume()
      return vol === volume
    })
    if (bOk) this.#onRenderingControl({ volume: vol })
  }

  async setMute (mute) {
    await retry(() => this.#api.setMute(mute))
    const bOk = await verify(async () => {
      const { mute: mute_ } = await this.#api.getMute()
      return mute === mute_
    })
    if (bOk) this.#onRenderingControl({ mute })
  }

  async #playPause (val) {
    const fn = val ? () => this.#api.play() : () => this.#api.pause()
    await retry(fn)
    let data
    const bOk = await verify(async () => {
      data = await this.#api.getTransportInfo()
      return data.isPlaying === !!val
    })
    if (bOk) this.#onAvTransport(data)
  }

  async play () {
    return this.#playPause(true)
  }

  async pause () {
    return this.#playPause(false)
  }

  // ------------ Group Management ---------------

  async startGroup () {
    const data = await retry(() => this.#api.getCurrentGroup())
    if (data.leaderUuid === this.uuid) return

    await retry(() => this.#api.startOwnGroup())
    const bOk = await verify(async () => {
      const data = await this.#api.getCurrentGroup()
      return data.leaderUuid === this.uuid
    })
    if (bOk) this.#onLeader({ leaderUuid: this.uuid })
  }

  async joinGroup (leaderName) {
    const leader = this.players.byName[leaderName]
    assert(leader)

    const data = await retry(() => this.#api.getCurrentGroup())
    if (data.leaderUuid === this.uuid) {
      const uuids = data.memberUuids.filter(uuid => uuid !== this.uuid)
      for (const uuid of uuids) {
        const follower = this.players.byUuid[uuid]
        if (follower) await follower.startGroup()
      }
    }

    await retry(() => this.#api.joinGroup(leader.uuid))

    const bOk = await verify(async () => {
      const data = await this.#api.getCurrentGroup()
      return data.leaderUuid === leader.uuid
    })

    if (bOk) this.#onLeader({ leaderUuid: leader.uuid })
  }

  // ------------ Notification playing -----------

  async playNotification (url) {
    const { QUEUE } = ApiPlayer
    const delay = config.monitorPollDelay

    const isPlaying = async () => {
      const res = await retry(() => this.#api.getTransportInfo())
      return res.isPlaying
    }
    const wasPlaying = await isPlaying()

    if (wasPlaying) await this.pause()

    let res
    res = await retry(() => this.#api.getPositionInfo())
    const { trackNum, trackPos } = res

    res = await retry(() => this.#api.getMediaInfo())
    const { mediaUri, mediaMetadata } = res

    await retry(() => this.#api.setAVTransportURI(url))
    await this.play()

    let playing = true
    while (playing) {
      playing = await isPlaying()
      if (playing) await sleep(delay)
    }

    await retry(() => this.#api.setAVTransportURI(mediaUri, mediaMetadata))
    if (mediaUri.startsWith(QUEUE) && trackNum && trackPos) {
      await retry(() => this.#api.seekTrack(trackNum))
      await retry(() => this.#api.seekPos(trackPos))
    }

    if (wasPlaying) await this.play()
  }
}
