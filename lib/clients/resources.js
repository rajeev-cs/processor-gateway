import config from 'config';
import { getLogger } from '@tt-sensa/sensa-express-common';
import { K8sResources } from './k8sResources.js';
import { FilesystemResource } from './fileResources.js';

const logger = getLogger('gateway', config.get('logging'));
let instance;
async function getResourceProvider(opts = {}) {
    if (!instance) {
        if (config.resources.provider.toLowerCase() === 'k8s') {
            logger.warn('Using k8s resource provider');
            instance = new K8sResources();
        } else if (config.resources.provider.toLowerCase() === 'local') {
            logger.warn(`Using local resource provider from: ${config.resources.agentsPath}`);
            instance = new FilesystemResource(opts);
        }
        try {
            await instance.initialize();
        } catch (err) {
            logger.error(`Unable to initialize resource provider ${config.resources.provider}: ${err.message}`);
        }
    }
    return instance;
}
export { getResourceProvider };

