import ApiPlayer from '@ludlovian/jonos-api'
import Debug from '@ludlovian/debug'
import Timer from '@ludlovian/timer'
import diffObject from '@ludlovian/diff-object'
import { db, housekeep } from './database.mjs'
import { startTaskMonitor, stopTaskMonitor, doTask } from './task.mjs'
import Player from './player.mjs'
import { notify, tick } from './notify.mjs'
import { retry } from './util.mjs'
import config from './config.mjs'

export default class Players {
  all = []
  byName = {}
  byUuid = {}

  doTask = doTask
  db = db

  #debug
  #listening
  #onListening
  #started = false
  #tmDelayedStop

  constructor () {
    this.#debug = Debug('jonos-model:model')
  }

  // -------- Discovery ---------------------------------
  //

  async discover () {
    const topology = await ApiPlayer.discover()
    this.onTopology(topology)
  }

  onTopology ({ players }) {
    this.#buildTopology(players)
    for (const { uuid, leaderUuid } of this.#topologyChanges(players)) {
      this.byUuid[uuid].onLeader({ leaderUuid })
    }
  }

  #buildTopology (players) {
    // step 1 - Add players missing from the DB
    const dbUuids = new Set(db.pluck.all('select uuid from player'))
    const newDbPlayers = players.filter(({ uuid }) => !dbUuids.has(uuid))
    for (const player of newDbPlayers) {
      const { uuid, url, fullName } = player
      const sql = `
        insert into player(uuid, url, fullName)
        values ($uuid, $url, $fullName)
      `
      db.run(sql, { uuid, url, fullName })
      dbUuids.add(uuid)
    }

    // step 2 - remove extraneous players (rare)
    const excessDbPlayers = new Set(dbUuids)
    players.forEach(({ uuid }) => excessDbPlayers.delete(uuid))
    excessDbPlayers.forEach(uuid => {
      db.run('delete from player where uuid=$uuid', { uuid })
      dbUuids.delete(uuid)
    })

    // step 3 - Add in new Player objects
    const currUuids = new Set(Object.keys(this.byUuid))
    const newUuids = [...dbUuids].filter(uuid => !currUuids.has(uuid))
    newUuids.forEach(uuid => {
      const id = db.pluck.get('select id from player where uuid=$uuid', {
        uuid
      })
      const p = new Player(this, id)
      this.all.push(p)
      this.byName[p.name] = p
      this.byUuid[p.uuid] = p
      currUuids.add(uuid)
    })

    // step 4 - remove extraneous players (rare)
    const excessUuids = new Set(currUuids)
    dbUuids.forEach(uuid => excessUuids.delete(uuid))
    excessUuids.forEach(uuid => {
      const p = this.byUuid[uuid]
      p.stop() // no await, just let it dangle
      this.all.splice(this.all.indexOf(p), 1)
      delete this.byName[p.name]
      delete this.byUuid[p.uuid]
    })
  }

  #topologyChanges (players) {
    const sql = `
      select b.uuid as uuid, c.uuid as leaderUuid
      from playerStatus a
      join player b on b.id = a.id
      join player c on c.id = a.leader
    `
    const rows = db.all(sql)
    const leaders = Object.fromEntries(rows.map(r => [r.uuid, r.leaderUuid]))
    return players
      .filter(({ uuid, leaderUuid }) => leaders[uuid] !== leaderUuid)
      .map(({ uuid, leaderUuid }) => ({ uuid, leaderUuid }))
  }

  // -------- Start and Stop ----------------------------
  //

  async start () {
    this.#started = true
    housekeep({ start: true })
    await retry(() => this.discover())
    startTaskMonitor(this)
    this.#debug('model started')
  }

  async stop () {
    stopTaskMonitor()
    this.#tmDelayedStop?.cancel()
    if (notify.count()) notify.clear()
    if (this.#listening) await this.#stopListening()
    this.#debug('model stopped')
    this.#started = false
  }

  // -------- Listening ---------------------------------
  //

  #startListening () {
    if (this.#listening) return
    this.#listening = true
    retry(async () => {
      await Promise.all(this.all.map(p => p.start()))
      this.#debug('Started listening')
      this.#onListening?.(true)
    })
  }

  #stopListening () {
    if (!this.#listening) return
    retry(async () => {
      await Promise.all(this.all.map(p => p.stop()))
      this.#debug('Stopped listening')
      this.#listening = false
      housekeep({ idle: true })
      this.#onListening?.(false)
    })
  }

  onListening (fn) {
    this.#onListening = fn
  }

  listen (fn, opts) {
    this.#tmDelayedStop?.cancel()
    if (!notify.count()) {
      this.#startListening()
    }
    const dispose = notify(fn, opts)
    const sql = 'update systemStatus set listeners=$count'
    db.run(sql, { count: notify.count() })
    tick()

    this.#debug('listening: %d', notify.count())

    return () => {
      dispose()
      if (!notify.count()) {
        this.#tmDelayedStop = new Timer({
          ms: config.idleTimeout,
          fn: this.#stopListening.bind(this)
        })
      }
      db.run(sql, { count: notify.count() })
      tick()
      this.#debug('listening: %d', notify.count())
    }
  }

  // -------- Subscribe ---------------------------------
  //

  subscribe (callback, opts) {
    if (!this.#started) this.start()
    let prev = {}
    const sql = 'select state from state'

    // call it once on the next tick
    return this.listen(onUpdate, opts)

    function onUpdate () {
      const state = JSON.parse(db.pluck.get(sql))
      const diff = diffObject(prev, state, opts)
      prev = state
      if (Object.keys(diff).length) callback(diff)
    }
  }
}
