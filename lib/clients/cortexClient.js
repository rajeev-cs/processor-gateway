import _ from 'lodash';
import path from 'path';
// eslint-disable-next-line import/no-unresolved
import got from 'got';
import config from 'config';
import NodeCache from 'node-cache';
import { importJWK, SignJWT } from 'jose';
import { parseJwt } from '@tt-sensa/sensa-express-common';

const secretCache = new NodeCache({ stdTTL: config.get('services.accounts.cacheTTL') }); // cache secrets for 5 minutes
const tokenCache = new NodeCache({ stdTTL: 60 * 60 }); // cache tokens for 1 hour
/**
 * generate an external JWT from a pat config
 * <This is copied from cortex-cli/src/config.js>
 * @param profile
 * @param expiresIn
 * @return {Promise<*>}
 */
async function generateJwt(pat, expiresIn = '2m') {
    const {
 username, issuer, audience, jwk, 
} = pat;
    const jwtSigner = await importJWK(jwk, 'Ed25519');
    return new SignJWT({})
        .setProtectedHeader({
        alg: 'EdDSA',
        kid: jwk.kid,
    })
        .setSubject(username)
        .setAudience(audience)
        .setIssuer(issuer)
        .setIssuedAt()
        .setExpirationTime(expiresIn)
        .sign(jwtSigner, { kid: jwk.kid });
}
class ManagedContentClient {
    constructor(token) {
        this.endpoint = config.get('services.connections.endpoint');
        this.token = token;
    }

    /**
     * Download task artifact from managed content
     * @param token
     * @return {Promise<*>}
     */
    async download(project, key) {
        const uri = `${this.endpoint}/fabric/v4/projects/${project}/content/${key}`;
        const options = {
            isStream: true,
            headers: { Authorization: `Bearer ${this.token}` },
        };
        try {
            return got.stream(uri, options);
        } catch (e) {
            let message = `Unable to download managed content ${key} from project ${project}`;
            if (e?.response) {
                message += JSON.stringify(e.response.body);
            } else {
                message += e.message;
            }
            throw Error(message);
        }
    }
}
class SecretsClient {
    constructor(token) {
        this.endpoint = config.get('services.accounts.endpoint');
        this.token = token;
    }

    async _getSecrets(projectId, keys, rootKey = '') {
        if (!_.isArray(keys)) {
            throw new Error('keys must be an array');
        }
        if (_.isEmpty(keys)) {
            return [];
        }
        const initialValues = _.fromPairs(keys.map((k) => [k, undefined]));
        const uri = path.posix.join(this.endpoint, 'internal/projects', projectId, 'secrets', rootKey, `?keys=${keys.join(',')}`);
        const options = {
            responseType: 'json',
            headers: { Authorization: `Bearer ${this.token}` },
        };
        try {
            const secRes = await got(uri, options);
            const secValues = secRes.body;
            // API doesn't return 404 return 200 with empty response
            if (_.isEmpty(secValues)) throw Error('Secrets not found');
            const diff = _.difference(keys, Object.keys(secValues));
            if (!_.isEmpty(diff)) throw Error(`Secrets not found [${diff.join(',')}]`);
            return _.values(_.merge(initialValues, _.mapValues(secValues, (v) => v.value)));
        } catch (e) {
            let message = `Unable to fetch secret [${keys.join(',')}]: `;
            if (e?.response) {
                message += JSON.stringify(e.response.body);
            } else {
                message += e.message;
            }
            throw Error(message);
        }
    }

    /**
     * This is expensive as it talks to the accounts service
     * Using built in cache to hold the token for 1 hour...
     * @param patConfig
     * @return {Promise<unknown>}
     */
    async genFetchToken(patConfig) {
        // TODO ttl needed? make cache ttl 1/2 of token ttl ?
        try {
            let fatToken = tokenCache.get(patConfig.username);
            if (fatToken) {
                return fatToken;
            }
            const shadowToken = await generateJwt(patConfig);
            fatToken = await this.fetchFatToken(shadowToken);
            tokenCache.set(patConfig.username, fatToken);
            return fatToken;
        } catch (e) {
            tokenCache.del(patConfig.username); // remove from cache, so we don't use cached value again..
            throw e;
        }
    }

    /**
     * Convert the shadow token to the "fat" token
     * @param token
     * @return {Promise<*>}
     */
    async fetchFatToken(token) {
        // Might hit this from pat or token from headers so use same cache again.
        const username = parseJwt(token)?.payload?.sub;
        let fatToken = tokenCache.get(username);
        if (fatToken) {
            return fatToken;
        }
        const uri = path.posix.join(this.endpoint, 'internal/user');
        const options = {
            responseType: 'json',
            headers: { Authorization: `Bearer ${token}` },
        };
        try {
            const tokResp = await got(uri, options)
                .json();
            fatToken = tokResp.jwt;
            tokenCache.set(username, fatToken);
            return fatToken;
        } catch (e) {
            let message = 'Unauthorized: unable to convert shadow token -> fat token: ';
            if (e ?.response) {
                message += JSON.stringify(e.response.body);
            } else {
                message += e.message;
            }
            tokenCache.del(username); // remove from cache, so we don't use cached value again.
            throw Error(message);
        }
    }

    async getSecrets(projectId, keys, rootKey = '') {
        if (_.isEmpty(keys)) {
            return [];
        }
        const cacheKey = `${projectId}:${rootKey}${keys.join('')}`;
        let secVal = secretCache.get(cacheKey);
        try {
            if (!secVal) {
                secVal = await this._getSecrets(projectId, keys, rootKey);
                secretCache.set(cacheKey, secVal);
            }
            return secVal;
        } catch (e) {
            // Invalidate cache just in case.
            secretCache.del(cacheKey);
            throw e;
        }
    }
}
export { SecretsClient };
export { ManagedContentClient };
export default {
    SecretsClient,
    ManagedContentClient,
};
