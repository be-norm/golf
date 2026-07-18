import { registerEngine } from '../catalog'
import { skinsEngine } from './skins/engine'
import { nassauEngine } from './nassau/engine'
import { wolfEngine } from './wolf/engine'
import { vegasEngine } from './vegas/engine'

registerEngine(skinsEngine)
registerEngine(nassauEngine)
registerEngine(wolfEngine)
registerEngine(vegasEngine)

export { skinsEngine, nassauEngine, wolfEngine, vegasEngine }
