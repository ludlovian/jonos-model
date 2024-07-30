import Debug from '@ludlovian/debug'
import Players from './players.mjs'

const model = new Players()

if (Debug('jonos-model:model').enabled) global.jonosModel = model

export default model
