import _ from 'lodash';
import fs from 'fs';
import config from 'config';
import { glob } from 'glob';
import { getLogger } from '@tt-sensa/sensa-express-common';
import { KafkaConnector } from './kafka.js';

const logger = getLogger(config.get('name'), config.get('logging'));
const connectPlugins = {
    kafka: { KafkaConnector }.KafkaConnector,
};
function getConnectors() {
    try {
        const connFiles = glob.sync(`${config.connectors.configPath}/*.json`);
        const processed = {};
        const tuples = connFiles.map((connFile) => {
            const connData = fs.readFileSync(connFile);
            const connConfig = JSON.parse(connData);
            const ConnClass = connectPlugins?.[connConfig.type];
            if (_.has(processed, connConfig.name)) {
                logger.error(`Duplicate connector name "${connConfig.name}" found in ${connFile} skipped`);
                return [undefined, undefined];
            }
            return [connConfig.name, new ConnClass(connConfig)];
        });
        return _.omitBy(_.fromPairs(tuples), _.isNil);
    } catch (err) {
        logger.error(`Unable to load connectors: ${err.message}`);
        return [];
    }
}
export { getConnectors };
export default {
    getConnectors,
};
