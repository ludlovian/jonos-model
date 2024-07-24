import { db } from './src/database.mjs'
import { locateMedia } from './src/dbapi.mjs'
import Player from './src/player.mjs'
import { refreshCoverArt, refreshAlbums } from './src/refresh.mjs'

main()

async function main () {
  locateMedia('')
  await Player.discover()
  setupOther()
  setupRadio()

  console.log('starting refresh')
  await refreshCoverArt()
  await refreshAlbums()
  console.log('done')
}

// ----------------------------------------------------------------

function setupOther () {
  const otherMedia = [
    { name: 'web', file: 'library/web.png' },
    { name: 'tv', file: 'library/tv.png' }
  ]

  otherMedia.forEach(({ name, file }) => {
    let sql = 'insert or ignore into artwork(file) values($file)'
    db.run(sql, { file })
    sql = `
      update mediaType
      set artwork = (select id from artwork where file=$file)
      where name=$name
    `
    db.run(sql, { name, file })
  })
}

// ----------------------------------------------------------------

function setupRadio () {
  const radios = [
    {
      sonosUrl:
        'x-rincon-mp3radio://https://allclassical.streamguys1.com/ac128kmp3',
      title: 'All Classical Radio',
      file: 'library/allclassical.png'
    }
  ]
  radios.forEach(({ sonosUrl, title, file }) => {
    let sql = 'insert or ignore into artwork(file) values($file)'
    db.run(sql, { file })

    const { id } = locateMedia(sonosUrl)
    sql = 'insert into radio(id, title) values($id,$title)'
    db.run(sql, { id, title })

    sql = `
      update media
      set artwork = (select id from artwork where file=$file)
      where id = $id
    `
    db.run(sql, { id, file })
  })
}
// ----------------------------------------------------------------
