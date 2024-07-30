import Timer from '@ludlovian/timer'
import { db } from './database.mjs'
import config from './config.mjs'

// -------------------------------------------------------
//
// Commands (such as setVolume) can be called directly
// on the player instance. This is the preferred option
//
// But they can also be sent by other processes (or this one) by
// inserting them into the command table and setting the players commander
// running to process commands.
//
// Montiroring for external commands is done in two steps. First
// we check for the data_version pragma which shows if another
// connection to the db has updated it. If so, then we check the table
//
// If a row is added by this process, via addCommand here, it will not
// updted the data_version, so we must skip that first step

export default class CommandManager {
  #model
  #lastVersion
  #tmMonitor

  constructor (model) {
    this.#model = model
    this.addCommand = this.addCommand.bind(this)
  }

  addCommand (name, cmd, parms) {
    if (Array.isArray(parms) || (parms && typeof parms === 'object')) {
      parms = JSON.stringify(parms)
    }
    if (parms === undefined) parms = null
    const player = this.#model.byName[name]
    if (!player) {
      console.error('No such player: %s', name)
      console.error('Skipping task: %s', cmd)
      return
    }

    const sql = 'insert into command(player,cmd,parms) values($id,$cmd,$parms)'
    db.run(sql, { id: player.id, cmd, parms })
    player.checkCommands()
  }

  startMonitor () {
    this.#lastVersion = this.#getVersion()
    this.#tmMonitor = new Timer({
      ms: config.taskPoll,
      repeat: true,
      fn: () => this.#checkForCommand()
    })
  }

  stopMonitor () {
    this.#tmMonitor.cancel()
  }

  #getVersion () {
    return db.pluck.get('pragma data_version')
  }

  #checkForCommand () {
    const ver = this.#getVersion()
    if (ver === this.#lastVersion) return
    this.#lastVersion = ver
    const sql = 'select distinct player from commandEx'
    const names = db.pluck.all(sql)
    names.forEach(name => this.#model.byName[name].checkCommands())
  }
}
