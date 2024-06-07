import { batch } from '@preact/signals-core'

import Debug from '@ludlovian/debug'
import addSignals from '@ludlovian/signal-extra/add-signals'

import ApiPlayer from 'jonos-api'

import Player from './player.mjs'

export default class Players {
  #debug = Debug('jonos-model:players')
  isStarting

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

  updateSystem (data) {
    if (!data) return
    if ('players' in data) this.setPlayers(data.players)
  }

  async start () {
    if (this.isStarting) return this.isStarting
    this.isStarting = (async () => {
      if (!this.players.length) {
        await this.buildAll()
      }
      this.#debug('Players starting')
      await Promise.all(this.players.map(p => p.start()))
      this.isStarting = undefined
    })()
    return this.isStarting
  }

  async buildAll () {
    const { players } = await ApiPlayer.discover()
    this.setPlayers(players)
  }

  async stop () {
    if (!this.someListening) return
    await Promise.all(this.players.map(p => p.stop()))
    this.#debug('Players stopped')
  }

  async reset () {
    const isListening = this.isListening
    if (isListening) await this.stop()

    this.players = []
    await this.buildAll()

    if (isListening) await this.start()
  }

  setPlayers (players) {
    batch(() => {
      let count = 0
      if (players.length < this.players.length) {
        this.#debug('Players changed unexpectedly - resetting')
        this.players.forEach(p => p.detach())
        this.players = []
      }

      for (const { url, fullName, uuid, leaderUuid } of players) {
        let player = this.byUuid.get(uuid)
        if (!player) {
          count++
          player = new Player(this, url, { fullName, uuid })
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
