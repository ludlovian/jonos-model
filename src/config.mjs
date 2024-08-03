import configure from '@ludlovian/configure'

export default configure('JONOS_MODEL_', {
  // sqlite
  database: './db/jonos.db',

  // poll to see if extenal users have added to
  // command table
  taskPoll: 1000,

  // autocommit when refreshing
  commitDelay: 2000,

  // when making network calls
  callRetries: 2,
  callTimeout: '4s',
  callRetryDelay: '2s',

  // verify
  verifyTries: 3,
  verifyDelay: 250,

  // when monitoring notifies by polling
  monitorPollDelay: 500
})
