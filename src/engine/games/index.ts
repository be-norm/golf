import { registerEngine } from '../catalog'
import { skinsEngine } from './skins/engine'
import { nassauEngine } from './nassau/engine'
import { matchPlayEngine } from './matchPlay/engine'
import { wolfEngine } from './wolf/engine'
import { vegasEngine } from './vegas/engine'
import { sixPointEngine } from './sixPoint/engine'
import { ctpEngine } from './ctp/engine'

registerEngine(skinsEngine)
registerEngine(nassauEngine)
registerEngine(matchPlayEngine)
registerEngine(wolfEngine)
registerEngine(vegasEngine)
registerEngine(sixPointEngine)
registerEngine(ctpEngine)

export {
  skinsEngine,
  nassauEngine,
  matchPlayEngine,
  wolfEngine,
  vegasEngine,
  sixPointEngine,
  ctpEngine,
}
