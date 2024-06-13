import configure from '@ludlovian/configure'

export default configure('JONOS_', {
  libraryRoot: './library/files',
  libraryRootCifs: 'x-file-cifs://data2.local/data/',
  mediaRoot: './library/',
  mediaFile: 'media.json',

  callRetries: 3,
  callVerifyTimeout: '3s',

  idleTimeout: '10s',

  minSearchWord: 3
})
