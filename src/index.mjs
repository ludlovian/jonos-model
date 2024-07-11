import { effect } from '@preact/signals-core'
import Debug from '@ludlovian/debug'
import Timer from '@ludlovian/timer'
import signalbox from '@ludlovian/signalbox'

import config from './config.mjs'
import Players from './players.mjs'
import Library from './library.mjs'

class Model {
  #model
  #debug = Debug('jonos-model:model')
  #idleTimer
  #dispose

  players = new Players(this)
  library = new Library(this)

  constructor (model) {
    this.#model = model
    signalbox(this, {
      listeners: 0,
      _error: undefined,

      error: () => this._error ?? this.players.error
    })
  }

  get model () {
    return this.#model
  }

  #checkListeners () {
    const listeners = this.listeners

    // we have no listeners, so set the timeout going
    if (listeners === 0) {
      this.#idleTimer.refresh()
      return
    }

    // we have some listeners so start if necessary
    this.#idleTimer.cancel()
    this.players.start().catch(err => {
      this._error = this.error ?? err
    })
  }

  async start () {
    // start builds the library and the player set, but
    // doesn't start listening until we have some listeners

    const libraryBuild = this.library.loadFromStore()
    const playersBuild = this.players.buildAll()

    await playersBuild

    this.#idleTimer = new Timer({
      fn: () => this.players.stop(),
      ms: config.idleTimeout
    }).cancel() // configure but don't start
    this.#dispose = effect(this.#checkListeners.bind(this))

    await libraryBuild
  }

  async stop () {
    if (this.#dispose) this.#dispose()
    this.listeners = 0
    this.#dispose = undefined
    this.#idleTimer.cancel()
    await this.players.stop()
  }
}

const model = new Model()
if (Debug('jonos-model:model').enabled) global.jonosModel = { model }
export default model
