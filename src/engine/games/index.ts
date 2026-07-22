import { registerEngine } from '../catalog'
import { skinsEngine } from './skins/engine'
import { nassauEngine } from './nassau/engine'
import { wolfEngine } from './wolf/engine'
import { vegasEngine } from './vegas/engine'
import { sixPointEngine } from './sixPoint/engine'

registerEngine(skinsEngine)
registerEngine(nassauEngine)
registerEngine(wolfEngine)
registerEngine(vegasEngine)
registerEngine(sixPointEngine)

export { skinsEngine, nassauEngine, wolfEngine, vegasEngine, sixPointEngine }
