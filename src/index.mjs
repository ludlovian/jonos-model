import { effect } from '@preact/signals-core'

import Debug from '@ludlovian/debug'
import Timer from 'timer'
import addSignals from '@ludlovian/signal-extra/add-signals'

import config from './config.mjs'
import Players from './players.mjs'
import Library from './library.mjs'

class Model {
  #debug = Debug('jonos-model:model')
  #idleTimer
  #dispose

  players = new Players()
  library = new Library()

  constructor () {
    addSignals(this, {
      listeners: 0
    })
  }

  #checkListeners () {
    if (this.listeners === 0) {
      this.#idleTimer.refresh()
    } else {
      this.#idleTimer.cancel()
      if (!this.isStarting && !this.players.allListening) {
        this.players.start()
      }
    }
  }

  async start () {
    // start builds the library and the player set, but
    // doesn't start listening until we have some listeners

    const libraryBuild = this.library.scan()
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
global.model = model
export default model
