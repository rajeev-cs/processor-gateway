import config from 'config';
import { v4 as uuid } from 'uuid';
import WebSocketEventHandler from './socketEventHandler.js';
import { getEventHandlerInstance } from './handler.js';

class WebSocketEventListener {
    constructor(websocket, topic, filter, logger) {
        this.logger = logger;
        this.topic = topic;
        this.filter = filter;
        this.websocket = websocket;
        this.id = uuid();
    }

    async listen(eventHandlerCtrl, messageDispatch = null) {
        // this.logger.debug(`Events listener ${this.id} for topic ${this.topic}, filter: ${this.filter}`);
        const listener = this;
        this.publish = async (msg) => {
            // listener.logger.debug(`Events listener ${listener.id} publishing message ${msg}`);
            try {
                await listener.websocket.send(msg);
            } catch (err) {
                listener.logger.debug(`Events listener ${listener.id} error ${msg}`);
            }
        };
        this.websocket.on('message', async (msg) => {
            try {
                const response = await (messageDispatch ? messageDispatch(JSON.parse(msg)) || 'Okay' : 'Okay');
                await listener.publish(JSON.stringify(response));
            } catch (err) {
                await listener.publish(err.message);
            }
        });
        this.callback = async (msg) => {
            const stringMessage = JSON.stringify(msg);
            // listener.logger.debug(`Events listener ${listener.id} callback received ${stringMessage}`);
            // if no filter, publish anything received
            if (!listener.filter) {
                await listener.publish(stringMessage);
                return;
            }
            // if filter exists and matches eventType, publish
            if (listener.filter && listener.filter === msg.eventType) {
                await listener.publish(stringMessage);
            } else {
                listener.logger.debug(`Events listener ${listener.id} callback filtered out ${stringMessage}`);
            }
        };
        try {
            // TODO remove hackery
            const eventHandler = getEventHandlerInstance('ws');
            if (eventHandler instanceof WebSocketEventHandler) {
                this.timer = setInterval(async () => {
                    listener.logger.debug(`Events listener ${listener.id} sending ping`);
                    try {
                        await listener.websocket.ping();
                    } catch (err) {
                        listener.logger.warn(`Events listener ${listener.id} error ${err}`);
                    }
                }, config.agentEvents.pingInterval);
                this.websocket.on('close', async () => {
                    listener.logger.debug(`Events listener ${listener.id} closing websocket`);
                    try {
                        await eventHandler.removeListener(listener.topic, listener.callback);
                        await clearInterval(listener.timer);
                    } catch (err) {
                        listener.logger.warn(`Events listener ${listener.id} error ${err}`);
                    }
                });
                eventHandler.addListener(this.topic, this.callback);
            } else {
                this.logger.error('Attempting to create socket listener on for non SocketEventHandler');
            }
        } catch (err) {
            this.logger.error(`Websocket listener error: ${err.message}`);
        }
    }
}

export function subscribeToAgentEvents(ws, topic, filter, logger) {
    return new WebSocketEventListener(ws, topic, filter, logger);
}
