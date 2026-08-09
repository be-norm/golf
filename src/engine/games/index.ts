import { registerEngine } from '../catalog'
import { skinsEngine } from './skins/engine'
import { nassauEngine } from './nassau/engine'
import { wolfEngine } from './wolf/engine'
import { vegasEngine } from './vegas/engine'
import { sixPointEngine } from './sixPoint/engine'
import { ctpEngine } from './ctp/engine'

registerEngine(skinsEngine)
registerEngine(nassauEngine)
registerEngine(wolfEngine)
registerEngine(vegasEngine)
registerEngine(sixPointEngine)
registerEngine(ctpEngine)

export { skinsEngine, nassauEngine, wolfEngine, vegasEngine, sixPointEngine, ctpEngine }
