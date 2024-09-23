import _ from 'lodash';
import config from 'config';
import { getLogger } from '@tt-sensa/sensa-express-common';
import { nativeOmit } from '../utils.js';

const logger = getLogger('gateway', config.get('logging'));
export const COMMAND_CHANNEL = 'gateway-commands';
export const EVENT_CHANNEL = 'gateway-event';
export const COMMAND_SEND_EVENTS = 'agent-send-events';
export const COMMAND_STOP_EVENTS = 'agent-stop-events';
export const COMMAND_CACHE_UPDATE = 'cache-update';

const subscribeLog = (err, count) => {
    if (err) {
        logger.error(`Websocket event failed to subscribe: ${err.message}`);
    } else {
        // `count` represents the number of channels this client is currently subscribed to.
        logger.info(`Websocket event subscribed to ${count} channels.`);
    }
};
class WebSocketEventHandler {
    constructor({ redis, subRedis, resourceProvider }) {
        this.redis = redis;
        this.agentList = {};
        this.topics = {};
        this.subRedis = subRedis;
        this.resourceProvider = resourceProvider;
        // Always subscribe to COMMAND_CHANNEL
        subRedis.subscribe(COMMAND_CHANNEL, EVENT_CHANNEL, subscribeLog);
        const inst = this;
        subRedis.on('message', async (channel, message) => {
            if (channel === COMMAND_CHANNEL) {
                return inst.handleCommand(JSON.parse(message));
            }
            if (channel === EVENT_CHANNEL) {
                return inst.handleEvent(JSON.parse(message));
            }
            return undefined;
        });
    }

    // This is NOT restart friendly, clients will need to reconnect.
    async handleCommand(msg) {
        const { command, topic, op, resource, resourceType } = msg;
        logger.debug(`Handled pub/sub command ${command} ${topic || op}`);
        switch (command) {
            case COMMAND_SEND_EVENTS:
                this.agentList[topic] = msg;
                break;
            case COMMAND_STOP_EVENTS:
                delete this.agentList[topic];
                break;
            case COMMAND_CACHE_UPDATE: // Piggyback on event handler to broadcast cache updates to all GWS.
                if (op?.toLowerCase() == 'clear')
                 return this.resourceProvider.clearAll();
                if (op?.toLowerCase() == 'update')
                    return this.resourceProvider.update(resourceType, resource);
                if (op?.toLowerCase() == 'delete')
                    return this.resourceProvider.delete(resourceType, resource);
                break;
            default:
                logger.info(`Bad pub/sub command: ${msg}`);
        }
    }

    handleEvent(message) {
        const topic = message?.topic;
        const callback = this.topics?.[topic];
        if (callback) {
            callback(nativeOmit(message, 'topic'));
        }
    }

    addListener(topic, callback) {
        logger.debug(`Event Handler adding listener for ${topic}`);
        // Notify ALL GWs that I want events for an agent
        this.redis.publish(COMMAND_CHANNEL, JSON.stringify({ command: COMMAND_SEND_EVENTS, topic }));
        this.subRedis.subscribe(EVENT_CHANNEL, subscribeLog);
        this.topics[topic] = callback;
    }

    removeListener(topic) {
        logger.debug(`Event Handler removing listener for ${topic}`);
        this.subRedis.unsubscribe(EVENT_CHANNEL, subscribeLog);
        delete this.topics[topic];
        this.redis.publish(COMMAND_CHANNEL, JSON.stringify({ command: COMMAND_STOP_EVENTS, topic }));
    }

    static topicNameForAgent(projectId, agentName) {
        return `${projectId}-${agentName}`;
    }

    /**
     *  This will ONLY broadcast the event using REDIS pub/sub iff the topic is in this.agentList
     *  this.agent list is populated with topics when user subscribes to event via the websocket..
     * @param message
     * @return {Promise<void>}
     */
    async processEvent(message) {
        const { eventType, event } = message;
        const requestId = event?.message?.requestId ?? event.requestId;
        const projectId = event?.message?.projectId ?? event.projectId;
        const agentName = event?.message?.agentName ?? event.agentName;
        // Only send events I am interested in
        const topic = WebSocketEventHandler.topicNameForAgent(projectId, agentName);
        if (!_.has(this.agentList, topic)) {
            return; // nothing to do
        }
        event.timestamp = Date.now();
        const emitEvent = {
            topic,
            eventType,
            requestId,
            ...event,
        };
        if (projectId && agentName) {
            this.redis.publish(EVENT_CHANNEL, JSON.stringify(emitEvent));
        }
    }
}
export default WebSocketEventHandler;
