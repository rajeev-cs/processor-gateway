import { v4 as uuid } from 'uuid';
import { nativeOmit } from '../utils.js';

interface SynapseMessageOpt {
    agentName?: string;
    agentTitle?: string;
    channelId?: string;
    correlationId?: string;
    headers?: any;
    inputName?: string;
    messageId?: string;
    outputName?: string;
    payload: any;
    plan?: any;
    projectId: string;
    properties?: any;
    requestId?: string;
    serviceName?: string;
    sessionId?: string;
    skillName?: string;
    skillTitle?: string;
    sync?:boolean;
    timestamp?: number;
    token: string;
    username?: string;
}

export class SynapseMessage implements SynapseMessageOpt {

    agentName?: string;

    agentTitle?: string;

    channelId?: string;

    correlationId?: string;

    headers?: any;

    inputName?: string;

    messageId?: string;

    outputName?: string;

    payload: any;

    plan?: any;

    projectId: string;

    properties?: any;

    requestId: string;

    serviceName?: string;

    sessionId: string;

    skillName?: string;

    skillTitle?: string;

    // The request is synchronous
    sync?: boolean;

    timestamp?: number;

    token: string;

    username?: string;

    // TODO Record type
    constructor(msg: SynapseMessageOpt) {
            this.agentName = msg.agentName;
            this.agentTitle = msg.agentTitle;
            this.channelId = msg.channelId;
            this.serviceName = msg.serviceName;
            this.payload = msg.payload;
            this.projectId = msg.projectId;
            this.requestId = msg.requestId || uuid();
            this.sessionId = msg.sessionId || this.requestId;
            this.skillName = msg.skillName;
            this.skillTitle = msg.skillTitle;
            this.headers = msg.headers;
            this.timestamp = msg.timestamp || Date.now();
            // Needed for skill to return the output used..
            this.outputName = msg.outputName;
            this.properties = msg.properties || {};
            this.token = msg.token;
            // parent activationId from agent invoking agent.
            this.correlationId = msg.correlationId;
            // Only used for job messages
            this.messageId = msg.messageId;
            this.plan = msg.plan;
            this.sync = msg.sync;
            this.inputName = msg.inputName;
            this.username = msg.username;

    }

    getLogMeta() {
        return {
            activationId: this.requestId,
            agentName: this.agentName,
            agentTitle: this.agentTitle,
            channelId: this.channelId,
            projectId: this.projectId,
            sessionId: this.sessionId,
            skillName: this.skillName,
            skillTitle: this.skillTitle,
            correlationId: this.correlationId,
        };
    }

    toResponse() {
        return {
            payload: this.payload,
            activationId: this.requestId,
            // FAB-1743 this time is invoke api request time NOT invoke time so remove to avoid confusion
            //            elapsedTime: Date.now() - this.timestamp,
        };
    }

    toEventObject() {
        // Convert to plain object and strip out token
        return nativeOmit(this, 'token', 'plan');
    }

    /**
     * Returns a new synapse message with new payload
     * @param msg
     * @param payload
     */
    static replacePayload(msg, payload, channelId) {
        const m = new SynapseMessage(msg);
        m.timestamp = Date.now();
        m.payload = payload;
        m.channelId = channelId;
        return m;
    }

}

export default SynapseMessage;
