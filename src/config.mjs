import configure from '@ludlovian/configure'

export default configure('JONOS_MODEL_', {
  // sqlite
  database: './db/jonos.db',
  commitDelay: 2000,
  taskPoll: 500,

  // when making network calls
  callRetries: 2,
  callTimeout: '2s',
  callRetryDelay: '1s',

  // listener
  notifyDebounce: 200,
  idleTimeout: '10s',

  // verify
  verifyTries: 3,
  verifyDelay: 250,

  // when monitoring notifies by polling
  monitorPollDelay: 500,

  // old stuff
  libraryRoot: './library/files',
  libraryRootCifs: 'x-file-cifs://pi2.local/data/',
  mediaRoot: './library/',
  mediaFile: 'media.json',

  // when verifying via polling
  callPollDelay: 250,
  callPollCount: 3,

  minSearchWord: 3
})
