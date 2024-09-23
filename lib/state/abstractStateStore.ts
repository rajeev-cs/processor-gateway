    /* eslint-disable @typescript-eslint/no-unused-vars */
import _ from 'lodash';
import { scanAsync, parseIfJSON } from '@tt-sensa/sensa-express-common';
import { inject, injectable } from 'inversify';
    import { Infra } from '../interfaces/Infra.js';
    import { ActivationResponse } from '../interfaces/AgentTypes.js';

export const PENDING = 'PENDING';
export const STARTED = 'STARTED';
export const CANCELLED = 'CANCELLED';
export const RETRY = 'RETRIED'; // we've retried at least once.
export const COMPLETE = 'COMPLETE';
export const ERROR = 'ERROR';
export const TRANSPREFIX = '#';

@injectable()
export class StateStore {
    protected infra: Infra;

    constructor(@inject(Infra) infra: Infra) {
        this.infra = infra;
    }

    private parseJsonWithLog(str) {
        try {
            return JSON.parse(str);
        } catch (err) {
            // Make opaque default JSON parse error more informative
            const message = `invalid JSON: "${str}"`;
            this.infra.logger.error(message, {}, err);
            throw new Error(message);
        }
    }

    /*
     activations
     */
    async get(id: string): Promise<any> {
        throw Error('Not implemented');
    }

    async startActivation(id: string, m) {
        await this.setAgentStatus(id, PENDING);
    }

    async endActivation(id: string, response, end, status) {
        await this.setAgentStatus(id, status);
    }

    async listActivations(projectId: string, agentName: string, query: any): Promise<any[]> {
        throw Error('Not implemented');
    }

    /**
     * Generate a key for the transit within an activation, messageId is only used when using sendMessage()
     * @param from
     * @param to
     * @param messageId (optional)
     * @return {string}
     * @private
     */
     _getId(from: string, to: string, messageId: string): string {
        if (messageId) return `${TRANSPREFIX}${from}:${to}:${messageId}`;
        return `${TRANSPREFIX}${from}:${to}`;
    }

    /**
     * Create a transit status->STARTED indicating the skill/output has been invoked
     * messageId only used with sendMessage()
     * @param id
     * @param from
     * @param to
     * @param messageId (optional)
     * @param name concatenated name with skill name|skill title
     * @return {Promise<*>} number fields added
     */
    public async startTransit(id: string, from: string, to: string, messageId: string, name: string) {
        const tid = this._getId(from, to, messageId);
        await this.infra.redis.hset(id, tid, JSON.stringify({
            from,
            to,
            messageId,
            start: Date.now(),
            status: STARTED,
            name,
        }));
        return;
    }

    /**
     * Update status of a transit to either ERROR/COMPLETE
     * messageId only used with sendMessage()
     * @param id
     * @param from
     * @param to
     * @param status
     * @param messageId (optional)
     * @param throwIt throw missing transit exception (Default:true)
     * @return {Promise<*>} number fields added
     */
    public async completeTransit(id: string, from: string, to: string, status: string, messageId: string, throwIt: boolean = true) {
        const tid = this._getId(from, to, messageId);
        const transitStr = await this.infra.redis.hget(id, tid);
        if (!transitStr) {
            if (throwIt) {
                throw new Error(`Transit ${tid} not found`);
            }
            return 0;
        }
        const transit = this.parseJsonWithLog(transitStr);
        transit.status = status;
        transit.end = Date.now();
        // TODO Possible concurrency issue, not huge likely hood
        return this.infra.redis.hset(id, tid, JSON.stringify(transit));
    }

    /**
     * Used primarily with task call backs, find the transit(s) related to this skill
     * @param id
     * @param from
     * @param messageId - if available filter by messageId
     * @return {Promise<undefined|*>} List of transits or undefined if none
     */
    async getToTransits(id: string, from: string, messageId?: string) {
        const keys = await this.infra.redis.hkeys(id);
        // ${TRANSPREFIX}source:target:messageId Check tranit prefix to ensure we don't get "OTHER" keys by mistake
        const foundKeys = keys.filter((k) => k.startsWith(TRANSPREFIX) && k.split(':')[1] === `${from}`); // handle from==undefined for skill invokes
        if (_.isEmpty(foundKeys)) {
            return undefined;
        }
        const transitStrs = await this.infra.redis.hmget(id, ...foundKeys);
        const transits = transitStrs.map((str) => this.parseJsonWithLog(str || ''));
        if (_.isEmpty(messageId)) {
            return transits;
        }
        return transits.filter((t) => t.messageId === messageId);
    }

    /**
     * Dump all the transit so we can store them
     * @param id
     * @return {Promise<*>}
     */
    async getAllTransits(id: string) {
        const allKeys = await this.infra.redis.hgetall(id);
        return Object.keys(allKeys).filter((k) => k.startsWith(TRANSPREFIX)).map((k) => this.parseJsonWithLog(allKeys[k]));
    }

    /**
     * Remove activation from reds, clean-up
     * @param activationId - remove all keys prefixed with activation Id
     * @return {Promise<*>} number of records deleted
     */
    async _cleanup(activationId: string) {
        // if debug turned on then leave records in redis for diagnostics..
        if (_.isEmpty(process.env.DEBUG)) {
            const keys = []; // new Set();  // TODO vaidate
            await scanAsync(this.infra.redis, `${activationId}*`, (acc, key) => acc.push(key), keys);
            if (keys.length > 0)
                return this.infra.redis.del(...keys);
        }
        return 0;
    }

    /**
     *     Functions related to sendMessage()
     */
    /**
     * Keep track of # messages sent to channelId
     * @param activationId
     * @param channelId
     * @return {Promise<*>} the message count
     */
    async jobMessageSent(activationId: string, channelId: string): Promise<number> {
        return this.infra.redis.hincrby(activationId, `${channelId}.msgcnt`, 1);
    }

    /**
     * Keep track of # done messages to channelId
     * @param activationId
     * @param channelId
     * @return {Promise<*>} the done count
     */
    async jobMessageDone(activationId: string, channelId: string): Promise<number> {
        return this.infra.redis.hincrby(activationId, `${channelId}.msgdone`, 1);
    }

    /**
     * Keep track of # errored messages to channelId
     * @param activationId
     * @param channelId
     * @return {Promise<*>} the error count
     */
    async jobMessageError(activationId: string, channelId: string): Promise<void> {
        await this.infra.redis.hincrby(activationId, `${channelId}.msgerr`, 1);
    }

    /**
     * Keep track of retries
     * @param activationId
     * @return {Promise<*>} the error count
     */
    async incrAttempt(activationId: string): Promise<number> {
        return this.infra.redis.hincrby(activationId, 'attempts', 1);
    }

    /**
     * Get message stats for channelId
     * @param activationId
     * @param channelId
     * @return {Promise<*>} return stats {received, done, error }
     */
    async getJobMessageStats(activationId, channelId) {
        const res = await this.infra.redis.hmget(activationId, `${channelId}.msgcnt`, `${channelId}.msgdone`, `${channelId}.msgerr`);
        return { received: _.toInteger(res[0]), done: _.toInteger(res[1]), errors: _.toInteger(res[2]) };
    }

    /**
     * Check for tranits (skill invokes) that are not either COMPLETE|ERROR
     * @param id
     * @return {Promise<boolean>}
     */
    async allTransitsDone(id) {
        const allKeys = await this.infra.redis.hgetall(id);
        // Just check for transits string state STARTED ... collision !!unlikely!! as it only contains UUIDs + timestamps otherwise
        const transNotDone = Object.keys(allKeys).filter((k) => k.startsWith(TRANSPREFIX)).filter((k) => allKeys[k].includes(STARTED));
        return transNotDone.length === 0;
    }

    async setAgentStatus(id, status) {
        return this.infra.redis.hset(id, 'status', status);
    }

    async setPayload(id, payload) {
        return this.infra.redis.hset(id, 'payload', JSON.stringify(payload));
    }

    async storePlan(id, plan) {
        return this.infra.redis.hset(id, 'plan', JSON.stringify(plan));
    }

    async getPayload(id) {
        const rawPayload = await this.infra.redis.hget(id, 'payload');
        if (_.isEmpty(rawPayload)) return undefined;
        return parseIfJSON(rawPayload);
    }

    async getAgentState(id) {
        const [status, planJson] = await this.infra.redis.hmget(id, 'status', 'plan');
        const plan = _.isEmpty(planJson) ? undefined : parseIfJSON(planJson);
        return { status, plan };
    }
}
