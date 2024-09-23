import _ from 'lodash';
// @ts-ignore
import pack from '../../package.json' assert { type: 'json' };

const healthMap = { name: pack.name, version: pack.version };

export function healthCheck(req, res) {
    const unhealthy = _.findKey(healthMap, ['ok', false]);
    if (_.isEmpty(unhealthy)) {
        return res.status(200).send(healthMap);
    }
    return res.status(500).send(healthMap);
}

export function updateHealth(service, ok, message) {
    _.set(healthMap, service, { ok, message });
}
