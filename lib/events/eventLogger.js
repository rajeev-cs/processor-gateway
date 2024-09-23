import _ from 'lodash';
import config from 'config';
import { getLogger, toBoolean } from '@tt-sensa/sensa-express-common';

const logger = getLogger('agent-events', config.get('agentLogger'));
const logPayload = toBoolean(config.get('agentLogger.logPayload'));
const logProperties = toBoolean(config.get('agentLogger.logProperties'));
const omissions = ['token'];
if (!logPayload) omissions.push('payload');
if (!logProperties) omissions.push('properties');
class EventLogger {
    processEvent(message) {
        const eventType = message?.eventType;
        const event = message?.event ?? {};
        const cleanEvent = _.omit(event?.message ?? event, ...omissions);
        let level = 'info';
        if (_.has(event, 'message.error')) {
            level = 'error';
        }
        // TODO redact properties if secure=true??
        logger.log(level, `${eventType} event for ${event.agentName || ''} ${event.skillName || ''}`, { eventType, ...cleanEvent });
    }
}
export default EventLogger;
