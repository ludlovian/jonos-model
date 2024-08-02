import ApiPlayer from '@ludlovian/jonos-api'
import Debug from '@ludlovian/debug'
import Timer from '@ludlovian/timer'
import { db, housekeep } from './database.mjs'
import Player from './player.mjs'
import { notify, tick } from './notify.mjs'
import { retry } from './util.mjs'
import CommandManager from './command.mjs'

export default class Players {
  all = []
  byName = {}
  byUuid = {}

  db = db

  #debug
  onListening
  #started = false
  #tmDelayedStop
  #commandMgr

  constructor () {
    this.#debug = Debug('jonos-model:model')
    this.#commandMgr = new CommandManager(this)
    this.addCommand = this.#commandMgr.addCommand.bind(this.#commandMgr)
  }

  get isListening () {
    return this.all.some(p => p.isListening)
  }

  get allListening () {
    return this.all.every(p => p.isListening)
  }

  // -------- Discovery ---------------------------------
  //

  async discover () {
    await Promise.all(this.all.map(p => p.stop()))
    this.onTopology(await ApiPlayer.discover())
    const sql = 'select id from player'
    this.all = db.pluck.all(sql).map(id => new Player(this, id))
    this.byName = Object.fromEntries(this.all.map(p => [p.name, p]))
    this.byUuid = Object.fromEntries(this.all.map(p => [p.uuid, p]))
    await Promise.all(this.all.map(p => p.updateModel()))
    this.all.forEach(p => p.checkActions())
  }

  onTopology ({ players }) {
    players = JSON.stringify(players)
    let sql = 'insert into updatePlayerTopology values($players)'
    db.run(sql, { players })
    // Now signal any players that might need updates
    sql = 'select distinct name from playerActionsNeeded'
    const names = db.pluck.all(sql)
    names.forEach(name => this.byName[name]?.checkActions())
    tick()
  }

  // -------- Start and Stop ----------------------------
  //

  async start () {
    this.#started = true
    housekeep({ start: true })
    await retry(() => this.discover())
    this.#commandMgr.startMonitor()
    this.#debug('model started')
  }

  async stop () {
    this.#tmDelayedStop?.cancel()
    this.#commandMgr.stopMonitor()
    if (notify.count()) notify.clear()
    await this.#stopListening()
    db.close()
    this.#debug('model stopped')
    this.#started = false
  }

  // -------- Listening ---------------------------------
  //

  async #startListening () {
    if (!this.#started) await this.start()
    await retry(async () => {
      await Promise.all(this.all.map(p => p.start()))
      const item = 'listening'
      const val = 1
      const sql = 'update systemStatus set value=$val where item=$item'
      db.run(sql, { item, val })
      tick()
      this.#debug('Started listening')
      this.onListening?.(true)
    })
  }

  async #stopListening () {
    await retry(async () => {
      await Promise.all(this.all.map(p => p.stop()))
      const item = 'listening'
      const val = 0
      const sql = 'update systemStatus set value=$val where item=$item'
      db.run(sql, { item, val })
      tick()
      this.#debug('Stopped listening')
      housekeep({ idle: true })
      this.onListening?.(false)
    })
  }

  listen (fn, opts) {
    this.#tmDelayedStop?.cancel()
    if (!this.allListening) this.#startListening()
    const dispose = notify(fn, opts)
    const item = 'listeners'
    const sql = 'update systemStatus set value=$val where item=$item'
    db.run(sql, { item, val: notify.count() })
    tick()

    this.#debug('listeners: %d', notify.count())

    return () => {
      dispose()
      if (!notify.count()) {
        const idleTimeout = db.getSetting('idleTimeout') ?? 0
        this.#tmDelayedStop = new Timer({
          ms: idleTimeout,
          fn: this.#stopListening.bind(this)
        })
      }
      db.run(sql, { item, val: notify.count() })
      tick()
      this.#debug('listeners: %d', notify.count())
    }
  }

  // -------- Subscribe ---------------------------------
  //

  subscribe (callback, opts) {
    let lastChange
    let bInitialStateSent = false

    return this.listen(onUpdate, opts)

    function onUpdate () {
      let changes
      if (!bInitialStateSent) {
        const sql = 'select id, player, key, value from currentState'
        changes = db.all(sql)
        lastChange = changes[0].id
        bInitialStateSent = true
      } else {
        const sql = `
          select id, player, key, value from playerChangeEx
          where id>$lastChange order by id
        `
        changes = db.all(sql, { lastChange })
        if (changes.length) {
          lastChange = changes[changes.length - 1].id
        }
      }
      if (changes.length) {
        callback(
          changes.map(({ id, player, key, value }) => [id, player, key, value])
        )
      }
    }
  }
}
