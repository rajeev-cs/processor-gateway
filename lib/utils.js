import mustache from 'mustache';
import * as Boom from '@hapi/boom';
import { isMainThread, threadId } from 'node:worker_threads';
import { parseJwt } from '@tt-sensa/sensa-express-common';

export function streamToString(stream) {
    const chunks = [];
    return new Promise((resolve, reject) => {
        stream.on('data', (chunk) => chunks.push(chunk));
        stream.on('error', (err) => reject(err));
        stream.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    });
}

/**
 * Replace Lodash omit with native
 * @param object
 * @param keys
 * @returns {*}
 */
export function nativeOmit(object, ...keys) {
    const result = { ...object };
    for (const key of [...keys]) {
        delete result[key];
    }
    return result;
}

/**
 * Test that string isn't undefined, whitespace, or empty
 * @param str
 * @returns {boolean}
 */
export function notEmptyString(str) {
    return str?.trim()?.length > 0;
}

/**
 * Add error handling to mustache
 * Use this as a singleton, as this wraps the same function over/over if called more than once
 * @returns mustache
 */

function GomezMustacheFn() {
    const errors = new Set();
    // Store old functions
    const lookup = mustache.Context.prototype.lookup;
    const render = mustache.render;
    // Add undefined check and error list
    mustache.Context.prototype.lookup = function (name) {
        const value = lookup.bind(this)(name);
        if (value === undefined) {
            errors.add(name);
        }
        return value;
    };

    // If errors > 0 throw
    mustache.render = function (template, view, partials) {
        errors.clear();
        const result = render.bind(this)(template, view, partials);
        if (errors.size > 0) {
            throw new Error(`Template missing keys: ${[...errors].join(', ')}`);
        }
        return result;
    };
    return mustache;
}

/**
 * Export singleton of wrapped mustache function
 * @type mustache
 */
export const GomezMustache = GomezMustacheFn();
export function getThreadName() {
    if (isMainThread) {
        return 'Thread_main';
    }
    return `Thread_${threadId}`;
}

/**
 * Parse JSON obj if not an object already
 * @param obj
 * @returns {any}
 */
export function parseJson(obj) {
    // Existing utility parseIfJSON() is recursive, just wanted first pass parse
    if ((!!obj) && (obj.constructor === Object)) {
        return obj;
    }
    return JSON.parse(obj);
}

/**
 * Obtain & Parse the JWT from the HTTP request, typically used on internal calls using the internal token
 * where the auth middle can't be used/.
 */
export function parseAuthHeader(req) {
    const authHeader = req?.headers?.authorization;
    let jwt;
    if (authHeader) {
        const tokens = authHeader.split(' ');
        if (tokens.length === 2 && tokens[0].toLowerCase() === 'bearer') {
            [, jwt] = tokens;
        }
    }
    if (!authHeader || !jwt) {
        throw Boom.unauthorized('Fabric: Invalid request authorization header missing');
    }
    const { payload } = parseJwt(jwt);
    if (!payload.sub) {
        throw Boom.unauthorized('Fabric: Invalid request authorization header');
    }
    return { exp: payload?.exp, username: payload?.sub, jwt };
}
