/* eslint-disable @typescript-eslint/no-unused-vars */
import config from 'config';
import { injectable } from 'inversify';
import { tok8sName } from '@tt-sensa/sensa-express-common/k8s.js';
import { getLogger, toBoolean } from '@tt-sensa/sensa-express-common';
import { decodeResource } from './decoders.js';
import { getThreadName } from '../utils.js';

const logger = getLogger('gateway', config.get('logging'));

const NOCACHE = toBoolean(config?.features?.disable_cache ?? false);

if (NOCACHE) {
    logger.warn('Agent/Skill/Plan cache is disabled');
}
@injectable()
class ResourceProvider {
    protected cache: { [id: string]: any };

    constructor() {
        this.cache = {
            agents: new Map<string, any>(),
            skills: new Map<string, any>(),
            plans: new Map<string, any>(),
        };
    }

    /**
     * Initialize the provider.  Returns a promise that resolves when initialization is complete.
     * The promise contains the initialized provider instance.
     */
    async initialize() {
        throw new TypeError('Abstract method initialize not implemented.');
    }

    async getAgent(projectId, name) {
        if (NOCACHE) return undefined;
        const agentName = tok8sName(projectId, name);
        return this.cache.agents[agentName];
    }

    async getSkill(projectId, name) {
        if (NOCACHE) return undefined;
        const skillName = tok8sName(projectId, name);
        return this.cache.skills[skillName];
    }

    async getPlan(key: string): Promise<any> {
        if (NOCACHE) return undefined;
        return this.cache.plans[key];
    }

    async putPlan(key: string, plan: any): Promise<any> {
        if (NOCACHE) return;
        this.cache.plans[key] = plan;
    }

    // Update local cache
    async update(type: string, resource: any): Promise<string> {
        if (NOCACHE) return;
        // Decode k8s resource and Store locally
        const cacheEntry = decodeResource(resource);
        const { name } = cacheEntry.metadata;
        logger.debug(`Resource ${type} added: ${name} (${getThreadName()}): ${cacheEntry.metadata.resourceVersion}`);
        if (type === 'agents') { // remove plans for agent
            this.clearPlanByName(name);
        }
        this.cache[type][name] = cacheEntry;
        return `updated ${type} ${name}`;
    }

    clearPlanByName(prefix: string) {
        const keys = Object.keys(this.cache.plans);
        keys.forEach((k) => {
            if (k.startsWith(prefix)) {
                delete this.cache.plans[k];
            }
        });
    }

    async clearAll() {
        // map.clear() just sets size =0, and leaves elements
       this.cache = {
           agents: new Map<string, any>(),
           skills: new Map<string, any>(),
           plans: new Map<string, any>(),
       };
       return 'caches cleared';
    }

    async list(type) {
        return Object.keys(this.cache[type]);
    }

    async delete(type: string, resource: any) {
        const { name } = resource.metadata;
        logger.debug(`Resource ${type} deleted (${getThreadName()}): ${name}`);
        delete this.cache[type][name];
        if (type === 'agents') {  // remove plans for agent
            this.clearPlanByName(name);
        }
        return `deleted ${type} ${name}`;
    }

}
export { ResourceProvider };
export default {
    ResourceProvider,
};
