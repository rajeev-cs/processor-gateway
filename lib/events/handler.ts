import config from 'config';
import { EventEmitter } from 'node:events';
import { getLogger } from '@tt-sensa/sensa-express-common';
import EventLogger from './eventLogger.js';
import WebSocketEventHandler from './socketEventHandler.js';
import { Infra } from '../interfaces/Infra.js';

const logger = getLogger('gateway', config.get('logging'));
const AGENT_EVENT = 'agent-event';
export class EventHandler {
    
    private emitter: EventEmitter;
    
    constructor(emitter) {
        this.emitter = emitter;
    }

    addListener(handler) {
        const cb = handler.processEvent.bind(handler);
        this.emitter.addListener(AGENT_EVENT, cb);
    }

    removeListener(hander) {
        this.emitter.removeListener(AGENT_EVENT, hander.processEvent);
    }

    publishEvent(activationId, eventType, event) {
        this.emitter.emit(AGENT_EVENT, { activationId, eventType, event });
    }
}
const eventEmitter = new EventEmitter();
/**
   1) start up the emitter to publishEvents
   2) register logger & websocketEvent listener to listen for events
 */
const instances: any = {};
export function createEventHandler(infra: Infra): EventHandler {
        const singleton = new EventHandler(eventEmitter);
        const handlers = config.has('agentEvents.handler') ? [config.get('agentEvents.handler')] : config?.agentEvents?.handlers ?? [];
        handlers.forEach((h) => {
            switch (h.toLowerCase()) {
                case 'ws':
                    instances.ws = new WebSocketEventHandler(infra);
                    singleton.addListener(instances.ws);
                    break;
                case 'log':
                    instances.log = new EventLogger();
                    singleton.addListener(instances.log);
                    break;
                default:
                    logger.error(`Event Handler was not created, invalid type: ${h}`);
                    throw new Error(`Event Handler was not created, invalid type: ${h}`);
            }
        });
    return singleton;
}

export function getEventHandlerInstance(type) {
    return instances[type];
}
