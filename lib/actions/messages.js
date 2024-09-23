import config from 'config';
import lodash from 'lodash';

const { pick } = lodash;
const VALID_KEYS = [
    'activationId',
    'agentName',
    'apiEndpoint',
    'channelId',
    'headers',
    'messageId',
    'outputName',
    'payload',
    'projectId',
    'properties',
    'sessionId',
    'skillName',
    'skillTitle', // Added so users can see the title defined in the agent skill ref.
    'timestamp',
    'token',
];
class InputMessage {
    constructor(data) {
        VALID_KEYS.forEach((k) => this[k] = data[k]);
        this.timestamp = this.timestamp || Date.now();
        this.apiEndpoint = config.get('services.api.endpoint');
    }

    toParams() {
        return pick(this, VALID_KEYS);
    }
}
export { InputMessage };
export default {
    InputMessage,
};
