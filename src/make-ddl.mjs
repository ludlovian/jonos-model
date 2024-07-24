import { existsSync, readFileSync, writeFileSync } from 'node:fs'

if (existsSync('src/ddl/player.sql')) makeDdl()

function makeDdl () {
  const files = [
    // main setup
    'src/ddl/schema.sql',
    'src/ddl/settings.sql',
    'src/ddl/system.sql',
    // media
    'src/ddl/artwork.sql',
    'src/ddl/media-type.sql',
    'src/ddl/media.sql',
    'src/ddl/radio.sql',
    'src/ddl/search.sql',
    // library
    'src/ddl/track.sql',
    'src/ddl/album.sql',
    // player
    'src/ddl/player.sql',
    'src/ddl/player-status.sql',
    'src/ddl/queue.sql',
    // commands
    'src/ddl/task.sql',
    'src/ddl/notify.sql',
    'src/ddl/preset.sql',
    // views
    'src/ddl/media-metadata.sql',
    'src/ddl/player-state.sql',
    'src/ddl/system-state.sql',
    'src/ddl/state.sql'
  ]

  const ddl = files.map(name => readFileSync(name, 'utf8')).join('')
  writeFileSync('src/ddl.mjs', 'export default `' + ddl + '`\n')
}
