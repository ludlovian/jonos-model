import configure from '@ludlovian/configure'

export default configure('JONOS_MODEL_', {
  libraryRoot: './library/files',
  libraryRootCifs: 'x-file-cifs://data2.local/data/',
  mediaRoot: './library/',
  mediaFile: 'media.json',

  // when verifying via reactive until
  callRetries: 3,
  callVerifyTimeout: '3s',

  // when verifying via polling
  callPollDelay: 250,
  callPollCount: 3,

  // when monitoring by polling
  monitorPollDelay: 500,

  idleTimeout: '10s',

  minSearchWord: 3
})
