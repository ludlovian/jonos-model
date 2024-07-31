import configure from '@ludlovian/configure'

export default configure('JONOS_MODEL_', {
  // sqlite
  database: './db/jonos.db',
  commitDelay: 2000,
  taskPoll: 1000,

  // when making network calls
  callRetries: 2,
  callTimeout: '2s',
  callRetryDelay: '1s',

  // listener
  notifyDebounce: 200,

  // verify
  verifyTries: 3,
  verifyDelay: 250,

  // when monitoring notifies by polling
  monitorPollDelay: 500
})
