import _ from 'lodash';
import config from 'config';
import { getLogger } from '@tt-sensa/sensa-express-common';
import { K8SClient, tok8sName } from '@tt-sensa/sensa-express-common/k8s.js';
import { BroadcastChannel } from 'broadcast-channel';
import { decodeAgentResource, decodeSkillResource } from './decoders.js';
import { ResourceProvider } from './resourceProvider.js';
import { getThreadName } from '../utils.js';

const logger = getLogger('gateway', config.get('logging'));

const SHARED_PROJECT = config.resources.shareProject;
export const tpl = (key, value) => `${key} == ${value}`;

export class K8sResources extends ResourceProvider {
    private eventsChannel: BroadcastChannel;

    // Use k8s client wrapper from express common
    // Use same logic for namespace, http client setting etc.
    private k8sClient: K8SClient;

    constructor() {
        super();
        this.eventsChannel = new BroadcastChannel('events');
    }

    async initialize() {
        this.k8sClient = await K8SClient.newClient();

        // Need super methods, so we don't call bcast again.
        const superClearAll = super.clearAll.bind(this);
        const superUpdate = super.update.bind(this);
        const superDelete = super.delete.bind(this);
        this.eventsChannel.onmessage = function (data) {
            logger.debug(`Event received ${getThreadName()}`);
            if (data?.event === 'resource') {
                const { op, resource } = data;
                const type = _.toLower(`${resource.kind}s`);
                // This need to clear plan cache as well
                // Wrapper method were created as super.XXX doesn't work here.
                if (op === 'clearAll')
                    superClearAll();
                if (op === 'update') {
                    superUpdate(type, resource);
                } else if (op === 'delete') {
                    superDelete(type, resource);
                }
            }
        }.bind(this);
    }

    /**
     * Get agent from cache, otherwise check k8s if cache miss
     * @param projectId
     * @param name
     * @param cortexFormat
     */
    async getAgent(projectId, name) {
        let agent: any = await super.getAgent(projectId, name);
        // Try directly fetching the agent from k8s
        // This only supports a preconfigured namespace...
        if (!agent) {
            const agentName = tok8sName(projectId, name);
            try {
                const resource = await this.k8sClient.getResource('agent', agentName);
                agent = decodeAgentResource(resource);
                this.cache.agents[agentName] = agent;
            } catch (err) {
                logger.debug(`Agent "${agentName}" not found ( cache miss ): ${err.message}`);
            }
        }
        if (agent) {
            return { ...agent.spec, name: agent.metadata.name, updateTimeMS: agent.updateTimeMS };
        }
        return undefined;
    }

    /**
     * Get skill from cache, otherwise check k8s if cache miss
     * @param projectId
     * @param name
     * @param cortexFormat
     */
    async getSkill(projectId, name, cortexFormat = true) {
        let skill: any = await super.getSkill(projectId, name);
        if (!skill) {
            const skillName = tok8sName(projectId, name);  // k8s uses clobbered name
            try {
                const resource = await this.k8sClient.getResource('skill', skillName);
                skill = decodeSkillResource(resource);
                this.cache.skills[skillName] = skill;
            } catch (err) {
                if (projectId !== SHARED_PROJECT) { // If I haven't tried shared project look here in case.
                    return this.getSkill(SHARED_PROJECT, name, cortexFormat); // Just return the result already in correct format...
                }
                logger.debug(`Skill "${skillName}" not found ( cache miss )`);
                return undefined;
            }
        }
        if (skill && cortexFormat) {
            skill = {
                ...skill.spec,
                name: skill.metadata.name,
                projectId, // Inject so we have this later ( mainly for shared skills. )
                updateTimeMS: skill.updateTimeMS,
            };
        }
        return skill;
    }

    /**
     * Clear cached data, notify other thread to do the same.
     */
    async clearAll() {
        await super.clearAll();
        // Send command to workers
        logger.debug(`Resource cache cleared (${getThreadName()})`);

        await this.eventsChannel.postMessage({
            event: 'resource',
            op: 'clearAll',
        });
        return 'agent/skill caches cleared';
    }


    /**
     * Update local cache and broadcast update to other GWs and workers.
     * @param type
     * @param resource
     */
    async update(type: string, resource: any) {
        await super.update(type, resource);
        await this.eventsChannel.postMessage({  // Notify others
            event: 'resource',
            op: 'update',
            resource: resource,
        });
        return `update ${type} ${resource?.metadata?.name} submitted`;
    }

    /**
     * Delete local resource, and notify other GW and workers
     * @param type
     * @param resource
     */
    async delete(type: string, resource: any) {
        await super.delete(type, resource);
        await this.eventsChannel.postMessage({
            event: 'resource',
            op: 'delete',
            resource: resource,
        });
        return `delete ${type} ${resource?.metadata?.name} submitted`;
    }
}
