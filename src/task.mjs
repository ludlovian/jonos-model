import Timer from '@ludlovian/timer'
import Player from './player.mjs'
import { db } from './database.mjs'
import config from './config.mjs'
import { fatal } from './util.mjs'

// -------------------------------------------------------
//
// Tasks
//
// Changes are all applied via tasks
//
// Tasks can arrive in two ways
//
// -  internally generated ones call `doTask` which
//    performs the task asynchronously
//
// -  externally generated ones are inserted to the `task`
//    table, and we regularly poll for changes to pragma_data_version
//    which is a quick test to see if another connection has changed the
//    db
//
// -  tasks should not throw. Any errors are fatal by the time they get
//    here
//

export function doTask (name, cmd, p1, p2) {
  const player = Player.byName[name]
  if (!player) {
    console.error('No such player: %s', name)
    console.error('Skipping task: %s', cmd)
    return
  }

  return Promise.resolve()
    .then(async () => {
      return player.doTask(cmd, p1, p2)
    })
    .catch(fatal)
}

function checkTask () {
  if (!dataChanged()) return
  const task = db.get('select * from nextTask')
  if (!task) return
  const { id, player, cmd, p1, p2 } = task
  const sql = 'delete from task where id=$id'
  db.run(sql, { id })
  doTask(player, cmd, p1, p2)
}

let _previousVersion
function dataChanged () {
  const version = db.pluck.get('pragma data_version')
  if (version === _previousVersion) return false
  _previousVersion = version
  return true
}

const tm = new Timer({
  ms: config.taskPoll,
  repeat: true,
  fn: checkTask
}).cancel()

export function startTaskMonitor () {
  if (tm.active) return
  dataChanged()
  tm.refresh()
}

export function stopTaskMonitor () {
  tm.cancel()
}
