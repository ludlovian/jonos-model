import './make-ddl.mjs'

import Timer from '@ludlovian/timer'
import Debug from '@ludlovian/debug'
import diffObject from '@ludlovian/diff-object'
import Player from './player.mjs'
import { db, housekeep } from './database.mjs'
import { startTaskMonitor, stopTaskMonitor, doTask } from './task.mjs'
import { retry } from './util.mjs'
import { notify } from './notify.mjs'
import config from './config.mjs'

class Model {
  static #instance
  #listening = false
  #onListening
  #started = false
  #tmDelayedStop
  #debug = Debug('jonos-model:model')
  Player = Player
  doTask = doTask

  static get instance () {
    return this.#instance ?? (this.#instance = new Model())
  }

  constructor () {
    this.#tmDelayedStop = new Timer({
      ms: config.idleTimeout,
      fn: this.#stopListening.bind(this)
    }).cancel()
  }

  onListening (fn) {
    this.#onListening = fn
  }

  async start () {
    this.#started = true
    housekeep({ start: true })
    await retry(() => Player.discover())
    startTaskMonitor()
    this.#debug('model started')
  }

  async stop () {
    stopTaskMonitor()
    this.#tmDelayedStop.cancel()
    if (notify.count()) notify.clear()
    if (this.#listening) await this.#stopListening()
    this.#debug('model stopped')
    this.#started = false
  }

  listen (fn, opts) {
    this.#tmDelayedStop.cancel()
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
      if (!notify.count()) this.#tmDelayedStop.refresh()
      db.run(sql, { count: notify.count() })
      tick()
      this.#debug('listening: %d', notify.count())
    }
  }

  subscribe (callback, opts) {
    if (!this.#started) this.start()
    let prev = {}
    const sql = 'select state from state'

    // call it once on the next tick
    Promise.resolve().then(onUpdate)
    const dispose = this.listen(onUpdate, opts)

    function onUpdate () {
      const state = JSON.parse(db.pluck.get(sql))
      const diff = diffObject(prev, state, opts)
      prev = state
      if (Object.keys(diff).length) callback(diff)
    }
  }

  #startListening () {
    if (this.#listening) return
    this.#listening = true
    retry(async () => {
      await Promise.all(Player.all.map(p => p.start()))
      this.#debug('Started listening')
      this.#onListening?.(true)
    })
  }

  #stopListening () {
    if (!this.#listening) return
    retry(async () => {
      await Promise.all(Player.all.map(p => p.stop()))
      this.#debug('Stopped listening')
      this.#listening = false
      housekeep({ idle: true })
      this.#onListening?.(false)
    })
  }
}

// ---------------------------------------------------------------

const model = Model.instance
if (Debug('jonos-model').enabled) global.jonosModel = model
export default model
export { model, Player, doTask }
