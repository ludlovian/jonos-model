import { db } from './database.mjs'

export function buildTopology (players, Player) {
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
  const currUuids = new Set(Object.keys(Player.byUuid))
  const newUuids = [...dbUuids].filter(uuid => !currUuids.has(uuid))
  newUuids.forEach(uuid => {
    const id = db.pluck.get('select id from player where uuid=$uuid', {
      uuid
    })
    const p = new Player(id)
    Player.all.push(p)
    Player.byName[p.name] = p
    Player.byUuid[p.uuid] = p
    currUuids.add(uuid)
  })

  // step 4 - remove extraneous players (rare)
  const excessUuids = new Set(currUuids)
  dbUuids.forEach(uuid => excessUuids.delete(uuid))
  excessUuids.forEach(uuid => {
    const p = Player.byUuid[uuid]
    Player.all.splice(Player.all.indexOf(p), 1)
    delete Player.byName[p.name]
    delete Player.byUuid[p.uuid]
  })
}

export function topologyChanges (players) {
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
