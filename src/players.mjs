import { batch } from '@preact/signals-core'

import Debug from '@ludlovian/debug'
import addSignals from '@ludlovian/signal-extra/add-signals'
import Lock from '@ludlovian/lock'

import ApiPlayer from '@ludlovian/jonos-api'

import Player from './player.mjs'

export default class Players {
  #debug = Debug('jonos-model:players')
  #startStopLock = new Lock() // to serialise starting & stopping

  constructor () {
    addSignals(this, {
      players: [],

      byUuid: () => new Map(this.players.map(p => [p.uuid, p])),
      byUrl: () => new Map(this.players.map(p => [p.url, p])),
      byName: () => new Map(this.players.map(p => [p.name, p])),
      groups: () => Map.groupBy(this.players, p => p.leader),
      active: () => [...this.groups.keys()].filter(p => p.isPlaying),

      allListening: () =>
        this.players.length && this.players.every(p => p.listening),
      someListening: () =>
        this.players.length && this.players.some(p => p.listening)
    })
  }

  hardReset () {
    ApiPlayer.hardReset()
    this.players = []
  }

  updateSystem (data) {
    if (!data) return
    if ('players' in data) this.setPlayers(data.players)
  }

  start () {
    return this.#startStopLock.exec(async () => {
      if (!this.players.length) {
        await this.buildAll()
      }
      if (this.allListening) return

      this.#debug('Players starting')
      await Promise.all(this.players.map(p => p.start()))
    })
  }

  async buildAll () {
    const { players } = await ApiPlayer.discover()
    this.setPlayers(players)
  }

  stop () {
    return this.#startStopLock.exec(async () => {
      if (!this.someListening) return
      await Promise.all(this.players.map(p => p.stop()))
      this.#debug('Players stopped')
    })
  }

  setPlayers (players) {
    batch(() => {
      let count = 0
      if (players.length < this.players.length) {
        this.#debug('Players changed unexpectedly - resetting')
        this.hardReset()
      }

      for (const { url, fullName, uuid, leaderUuid } of players) {
        let player = this.byUuid.get(uuid)
        if (!player) {
          count++
          player = new Player(this, url, { fullName, uuid, leaderUuid })
          this.players = [...this.players, player]
        }
        player.updatePlayer({ leaderUuid })
      }

      if (count) {
        this.#debug('Added %d new players', count)
      }
    })
  }
}
