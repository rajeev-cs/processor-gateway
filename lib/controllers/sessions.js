import _ from 'lodash';
import { v4 as uuid } from 'uuid';
import * as boom from '@hapi/boom';
import { scanAsync, validateOptions } from '@tt-sensa/sensa-express-common';
import { nativeOmit } from '../utils.js';

export function makeKey(projectId, sessionId) {
    return `${projectId}.${sessionId}`;
}
export function getSessionIdFromRedisKey(s) {
    const parts = _.split(s, /[.|]/);
    return parts[1];
}
export default ({ redis, logger }) => {
    async function saveObject(parentKey, state, { ttl }) {
        // Stringify keys ( redis only stores strings )
        const sState = _.mapValues(state, (v) => JSON.stringify(v));
        return redis.hset(parentKey, sState)
            .then(() => {
            if (ttl > 0) redis.expire(parentKey, ttl);
        });
    }
    function safeParse(s) {
        try {
            return JSON.parse(s);
        } catch (e) {
            return s;
        }
    }
    async function startSession(projectId, sessionDef) {
        const {
             sessionId, ttl, description, state,
        } = sessionDef;
        const errors = [];
        if (ttl && !_.isNumber(ttl)) {
            // Consistent error format
            errors.push({
                message: '"ttl" must be a number',
                path: ['ttl'],
            });
        }
        if (!_.isEmpty(errors)) {
            throw boom.badRequest('Invalid session configuration', { details: errors });
        }
        const useSessionId = sessionId || uuid();
        try {
            await saveObject(makeKey(projectId, useSessionId), { 'sess.ttl': ttl, 'sess.descr': description || '', ...state }, { ttl });
            return {
                success: true,
                sessionId: useSessionId,
                message: `Session ${useSessionId} created successfully`,
            };
        } catch (err) {
            logger.error(err.message);
            throw boom.internal(`Unable to create a session: ${err.message}`);
        }
    }
    async function listSessions(projectId, query) {
        const { validOptions, errorDetails } = validateOptions(query);
        if (!validOptions) {
            throw boom.badRequest('Wrong params', { details: errorDetails });
        }
        const limit = _.toInteger(query?.limit ?? 100);
        try {
            const keys = new Set();
            await scanAsync(redis, `${projectId}*`, (acc, key) => acc.add(key), keys, limit);
            const sessions = await Promise.all([...keys].map(async (sessKey) => {
                const [ttl, description] = await redis.hmget(sessKey, 'sess.ttl', 'sess.descr');
                return {
                    sessionId: getSessionIdFromRedisKey(sessKey), ttl, description,
                };
            }));
            return { success: true, sessions };
        } catch (err) {
            throw boom.internal(`Unable to list sessions: ${err.message}`);
        }
    }
    async function getSession(projectId, sessionId) {
        const sessKey = makeKey(projectId, sessionId);
        const rawState = await redis.hgetall(sessKey);
        // Parse JSON encoded values ( redis only stores strings .. )
        return _.mapValues(rawState, (v) => safeParse(v));
    }

    async function getSessionRequest(projectId, sessionId, subKey) {
        
        const sessKey = makeKey(projectId, sessionId);
        try {
            if (subKey) {
                const val = await redis.hget(sessKey, subKey);
                return { success: true, state: { [subKey]: JSON.parse(val) } };
            }
            const rawSess = await getSession(projectId, sessionId);
            const state = nativeOmit(rawSess, 'sess.ttl', 'sess.descr');
            const description = rawSess?.['sess.descr'] ?? '';
            const ttl = rawSess?.['sess.ttl'] ?? 0;
            return {
                success: true, state, description, ttl,
            };
        } catch (err) {
            const message = `Sessions: ${err.message}`;
            logger.error(message, { projectId, sessionId, subKey });
            throw boom.internal(message);
        }
    }
    async function postSessionData(projectId, sessionId, state, ttl) {
        const sessKey = makeKey(projectId, sessionId);
        if (_.isEmpty(state)) {
            throw boom.badRequest('Sessions: state missing or incorrectly formatted');
        }
        if (Object.prototype.toString.call(state) !== '[object Object]') {
            throw boom.badRequest('Invalid state must be a JSON Object {}');
        }
        try {
            let useTTL = ttl;
            if (_.isEmpty(ttl)) {
                useTTL = await redis.hget(sessKey, 'sess.ttl');
            }
            await saveObject(sessKey, state, { ttl: _.toInteger(useTTL) });
            return { success: true, message: 'successfully added keys' };
        } catch (err) {
            const message = `Unable to update a session ${sessionId}: ${err.message}`;
            logger.error(message, { projectId, sessionId });
            throw boom.internal(message);
        }
    }
    async function deleteSession(projectId, sessionId) {
        const sessKey = makeKey(projectId, sessionId);
        let cnt;
        try {
            cnt = await redis.del(sessKey);
        } catch (err) {
            const message = `Sessions: ${err.message}`;
            logger.error(message, { projectId, sessionId });
            throw boom.internal(message);
        }
        if (cnt === 0) {
            throw boom.notFound('There is no data associated with this session');
        }
        return { success: true, message: `Deleted all session data for ${sessionId}` };
    }
    return {
        listSessions, getSessionRequest, getSession, postSessionData, deleteSession, startSession, makeKey,
    };
};
