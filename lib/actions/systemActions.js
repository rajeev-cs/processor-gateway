import _ from 'lodash';
import _eval from 'eval';
import { BroadcastChannel } from 'broadcast-channel';
// eslint-disable-next-line import/no-unresolved
import got from 'got';
import config from 'config';
import { toBoolean } from '@tt-sensa/sensa-express-common';
import redisSemaphore from 'redis-semaphore';
import { ActionProvider } from './abstractProvider.js';

const { Mutex } = redisSemaphore;
const callbackUrlBase = config.services.callback.endpoint;

const invokeChannel = new BroadcastChannel('invoke');

class SystemActions extends ActionProvider {
    constructor(infra) {
        super(undefined); // don't use resource provider
        this.redis = infra.redis;
    }

    initialize() {
        // nothing to do here
    }

    async invokeScript(projectId, skillName, actionName, params) {
        const {
 properties, payload, token, activationId, channelId, sessionId, outputName, apiEndpoint, 
} = params;
        const { script, async } = properties;
        // TODO Create a context object to wrap this and make it more extensible...
        const res = await _eval(`${script}; module.exports = invoke(payload, token, activationId, channelId, sessionId, properties, apiEndpoint)`, skillName, {
            payload,
            token,
            activationId,
            channelId,
            sessionId,
            properties,
            apiEndpoint,
            _,
            got,
        }, false);
        return ({
            async,
            success: res?.success ?? true,
            outputName: res?.outputName ?? outputName,
            payload: res.payload,
            error: res?.message,
        });
    }

    async invokeMerge(projectId, skillName, actionName, params) {
        const {
             properties, payload, activationId, channelId,
        } = params;
        const {
            items, payloadKey,
        // TODO add support for timeout if N calls do not come otherwise will stay pending forever..
        //            timeout,
         } = properties;
        const listKey = `${activationId}:${channelId}`;
        // Setup/Acquire lock using listKey, this is needed to prevent concurrency issues.
        const mutex = new Mutex(this.redis, listKey, {});
        // If box is locked I have to wait, hoping this isn't too costly..
        try {
            await mutex.acquire(); // TODO do I need logging around this ....
            const cnt = await this.redis.llen(listKey);
            if (cnt < items - 1) {
                this.redis.rpush(listKey, JSON.stringify(payload));
                // TODO add timer + call back to stop executing agent
                return ({
                    async: false,
                    outputName: 'ignore',
                    payload: {},
                    success: true,
                });
            }
            // grab previous payloads
            const rawPayloads = await this.redis.lrange(listKey, 0, -1);
            // Add current payload to previous ones
            const payloads = rawPayloads.map((p) => JSON.parse(p));
            payloads.push(payload);
            // cleanup
            this.redis.del(listKey);
            // TODO clear timer + call
            return ({
                async: false,
                outputName: 'output',
                success: true,
                payload: _.isEmpty(payloadKey) ? payloads : { [payloadKey]: payloads },
            });
        } finally {
            // release lock
            await mutex.release();
        }
    }

    async invokeAgent(projectId, skillName, actionName, params) {
        const {
            username, properties, payload, token, activationId, channelId, messageId, sessionId,
        } = params;
        const { agentName, serviceName } = properties;
        const passProperties = toBoolean(properties?.passProperties ?? false);
        const passSessionId = toBoolean(properties?.passSessionId ?? false);
        if (_.isEmpty(agentName)) {
            throw Error('Skill property "agentName" can not be empty');
        }
        if (_.isEmpty(serviceName)) {
            throw Error('Skill property "serviceName" can not be empty');
        }
        // piggyback on the task callback used for jobs.
        let callbackUrl = `${callbackUrlBase}/internal/tasks/${activationId}/${channelId}`;
        if (messageId?.trim().length > 0) {
            callbackUrl = `${callbackUrl}?messageId=${messageId}`;
        }
        const mesg = {
            projectId,
            username,
            agentName,
            serviceName,
            token,
            payload,
            correlationId: activationId,
            properties: passProperties ? { ...properties, callbackUrl } : { callbackUrl },
            sessionId: passSessionId ? sessionId : '',
            sync: false,
        };
        await invokeChannel.postMessage(mesg);
        return ({ async: true, success: true, payload: { message: `Invoked agent ${agentName}:${serviceName}` } });
    }

    async invoke(projectId, skillName, actionName, params) {
        switch (actionName) {
            case 'script':
                if (!toBoolean(config?.features?.scripted_skills ?? true)) {
                    throw new Error('features.scripted_skill not enabled, set env var `FEATURE_SCRIPTED_SKILLS="true"` to enable');
                }
                return this.invokeScript(projectId, skillName, actionName, params);
            case 'agentInvoke':
                return this.invokeAgent(projectId, skillName, actionName, params);
            case 'merge':
                return this.invokeMerge(projectId, skillName, actionName, params);
            default:
                throw new Error(`Unknown action ${actionName}`);
        }
    }
}
export { SystemActions };
export default {
    SystemActions,
};
