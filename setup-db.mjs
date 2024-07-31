import model from '@ludlovian/jonos-model'
import { refreshCoverArt, refreshAlbums } from './src/refresh.mjs'

const { db } = model

main()

async function main () {
  await model.discover()
  setupOther()
  setupRadio()
  console.log('starting refresh')
  await refreshCoverArt()
  await refreshAlbums()
  const sql = 'update media set metadata=null where metadata is null'
  db.run(sql)
  console.log('done')
}

// ----------------------------------------------------------------

function setupOther () {
  db.run("insert into ensureMedia values('')")
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
      url: 'x-rincon-mp3radio://https://allclassical.streamguys1.com/ac128kmp3',
      title: 'All Classical Radio',
      file: 'library/allclassical.png'
    }
  ]
  radios.forEach(({ url, title, file }) => {
    let sql = 'insert or ignore into artwork(file) values($file)'
    db.run(sql, { file })

    sql = 'insert into ensureMedia values($url)'
    db.run(sql, { url })
    sql = 'update media set title=$title where url=$url'
    db.run(sql, { url, title })

    sql = `
      update media
      set artwork = (select id from artwork where file=$file)
      where url=$url
    `
    db.run(sql, { url, file })
  })
}
// ----------------------------------------------------------------
