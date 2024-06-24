import { QUEUE, CIFS, RADIO, WEB, TV } from '@ludlovian/jonos-api/constants'

const rgxSystemNowPlaying = /^Z[A-Z_]+$/
const rgxValidTrack = /\.[a-z]+$/

export function isValidUrl (url) {
  return (
    url &&
    (url.startsWith(CIFS) ||
      url.startsWith(RADIO) ||
      url.startsWith(WEB) ||
      url.startsWith(TV))
  )
}

export function isValidTrackUrl (url) {
  return url && url.startsWith(CIFS) && rgxValidTrack.test(url)
}

export function isValidQueueUrl (url) {
  return url && url.startsWith(QUEUE)
}

export function isValidNotificationUrl (url) {
  return url && (url.startsWith(CIFS) || url.startsWith(WEB))
}

export function isValidNowPlaying (nowPlaying) {
  return nowPlaying && !rgxSystemNowPlaying.test(nowPlaying)
}
