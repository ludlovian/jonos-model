import Debug from '@ludlovian/debug'
import { db } from './database.mjs'
import { tick } from './notify.mjs'
import { doTask } from './task.mjs'

const debug = Debug('jonos-model:dbapi')

//  locateMedia
//
//  returns the { id, type } for a given url, creating
//  new ones if required
//

export function locateMedia (sonosUrl) {
  let sql = `
    select a.id, b.name as type from media a, mediaType b
    where a.sonosUrl=$sonosUrl and b.id=a.type
  `
  let parms = { sonosUrl }
  let row = db.get(sql, parms)
  if (row) return row
  //
  // find the type and default artwork for this
  // media
  sql = `
    select id as typeId, name as type, artwork from mediaType
    where $sonosUrl glob prefix || '*'
    order by id limit 1
  `
  parms = { sonosUrl }
  row = db.get(sql, parms)
  const { typeId, type, artwork } = row

  sql = `
    insert into media (type, sonosUrl, artwork)
    values ($typeId, $sonosUrl, $artwork)
    returning id
  `
  parms = { typeId, sonosUrl, artwork }
  const id = db.pluck.get(sql, parms)
  return { id, type }
}

// updatePlayer
//
// updates the player record with
//  - volume/mute
//  - leaderUuid
//  - playState/playMode
//  - media
//  - nowPlaying (if a radio)
//
//  Any or all could be optional (if undefined)
//
//  Returns true if the player needs further investigation

export function updatePlayer (data) {
  // debug('updatePlayer %s', JSON.stringify(data))
  const {
    id,
    volume,
    mute,
    playMode,
    playState,
    leaderUuid,
    sonosUrl,
    nowPlaying
  } = data
  let mediaType
  let media

  let sql = 'select * from playerStatus where id=$id'
  const curr = db.get(sql, { id })

  const parms = { ...curr }
  if (volume !== undefined) parms.volume = volume
  if (mute !== undefined) parms.mute = mute ? 1 : 0
  if (playMode !== undefined) parms.playMode = playMode
  if (playState !== undefined) parms.playState = playState
  if (leaderUuid !== undefined) {
    const sql = 'select id from player where uuid=$leaderUuid'
    parms.leader = db.pluck.get(sql, { leaderUuid })
    if (parms.leader !== id) mediaType = 'follow'
  }

  media = curr.media
  if (sonosUrl === null) {
    media = null
  } else if (sonosUrl !== undefined) {
    const m = locateMedia(sonosUrl)
    media = m.id
    mediaType = m.type
  }
  parms.media = media

  // Update the playerStatus row

  sql = `
    update playerStatus
    set (volume,mute,playMode,playState,leader,media) =
      ($volume,$mute,$playMode,$playState,$leader,$media)
    where id=$id
    and (volume,mute,playMode,playState,leader,media) is not
      ($volume,$mute,$playMode,$playState,$leader,$media)
    returning changes() as count
  `
  let changed = !!db.get(sql, parms)

  // If there was a change to a radios nowPlaying, then
  // we update the row on radio

  if (mediaType === 'radio' && nowPlaying !== undefined) {
    sql = `
      update radio set nowPlaying=$nowPlaying
      where id=$media and nowPlaying is not $nowPlaying
      returning changes() as count
    `
    if (db.get(sql, { media, nowPlaying })) changed = true
  }

  // If we are (probably) freshly following somebody
  // then remove any queue details

  if (mediaType === 'follow' && changed) {
    sql = 'update queue set items=null where player=$id'
    db.run(sql, { id })
  }

  // If we have been given a Url and something changed, then we check the queue
  //
  // If the media is not a track, the queue should be null
  //
  // If it is a track, then:
  // - the queue can be null if we are simply playing a single
  //   item (although unlikely). So we kick off a `getQueue` to check.
  //
  // - if (as is usually the case) the queue is not null, we ensure that the
  //   current item is on it. This means we might let an out-of-date queue
  //   be uncorrected until we start playing an item not on the queue
  //
  //   If there is a discrepancy, we kick off a getQueue

  if (sonosUrl && changed) {
    let bNeedCheck = false
    sql = 'select items from queue where player=$id'
    const items = db.pluck.get(sql, { id })
    if (mediaType !== 'track') {
      if (items !== null) {
        sql = 'update queue set items=null where player=$id'
        db.run(sql, { id })
      }
    } else {
      bNeedCheck = true
      if (items !== null) {
        const ids = JSON.parse(items)
        if (ids.includes(media)) bNeedCheck = false
      }
    }
    if (bNeedCheck) {
      sql = 'select name from player where id=$id'
      const name = db.pluck.get(sql, { id })
      doTask(name, 'getQueue')
    }
  }

  // If anything has changed, we update the lastplayed
  // on the media row
  if (changed && media !== null) {
    sql = 'update media set played=julianday() where id=$media'
    db.run(sql, { media })
  }

  if (changed) tick()
  return changed
}

export function updateQueue ({ id, urls }) {
  debug('Update queue: %d', id)
  let items = null
  if (urls) {
    items = urls.map(url => locateMedia(url).id)
    items = JSON.stringify(items)
  }
  const sql = `
    update queue set items=$items
    where player=$id and items is not $items
    returning changes() as count
  `
  if (db.get(sql, { id, items })) tick()
}
