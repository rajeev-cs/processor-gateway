import config from 'config';
import { Infra } from '../interfaces/Infra.js';
import { MongoStateStore } from './mongoStateStore.js';
import { InMemoryStateStore } from './inMemoryStateStore.js';
import { StateStore } from './abstractStateStore.js';

export function getStateStore(infra: Infra, storeType?: string): StateStore {
    const localStoreType = storeType ?? config.state.store;
    // if (!instance) {
    if (localStoreType === 'mongo') {
        return new MongoStateStore(infra);
    }
    if (localStoreType === 'memory') {
        infra.logger.warn('Using in memory state store.');
        return new InMemoryStateStore(infra);
    }
    infra.logger.error(`State store was not created, invalid type: ${localStoreType}`);
    throw new Error(`State store was not created, invalid type: ${localStoreType}`);
}
