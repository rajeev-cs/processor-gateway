import _ from 'lodash';
import config from 'config';
import { Kafka } from 'kafkajs';
import qname from '@tt-sensa/sensa-admin-db/lib/qname.js';
import { getLogger, parseIfJSON, parseJwt } from '@tt-sensa/sensa-express-common';
import Joi from 'joi';
import { Connector } from '../events/Connector.js';
import { SecretsClient } from '../clients/cortexClient.js';
import kafkaWrapper from './kafka/kafkaWrapper/index.js';
import { ERROR } from '../state/abstractStateStore.js';

const { QualifiedName } = qname;
const { Producer, Consumer } = kafkaWrapper;
const logger = getLogger(config.get('name'), config.get('logging'));
/**
 {
  "name": "kafkaDefault",
  "type": "kafka",
  "kafka": {
    "clientId": "gateway",
    "brokers": ["fabric-cluster-kafka-bootstrap.kafka.svc.cluster.local:9092"],
    "groupId": "gateway",
    "inTopic": "fabric-in",
    "retryTopic": "fabric-err",
    "outTopic": "fabric-out",
    "format": "JSON"
  },
  "pat": {
    "jwk": {
      "crv": "Ed25519",
      "x": "hgLTjmVDLr4L-_kVTIAo5_2-VLxVmhHoFR5dZPYZwoU",
      "d": "Ui6FW95O02GUg4E0ow54ZCNUkZGTYGPWENbjgt-YOJ4",
      "kty": "OKP",
      "kid": "Wh8iRyDZh7ViepiBezZt215j6RIe5pGXHJlTDJZkV9w"
    },
    "issuer": "cognitivescale.com",
    "audience": "cortex",
    "username": "27b526b2-fe8f-4519-b5e9-953f666abb9a",
    "url": "https://192.168.39.198:32427"
  },
  "retryable": "() => false",
  "before": "(msg) => msg",
  "after": "(msg) => msg"
}
 */
const kafkaConfigSchema = Joi.object({
    name: Joi.string().required(),
    type: Joi.string().required(),
    kafka: Joi.object({
        config: Joi.object({
            clientId: Joi.string().required(),
        }),
        groupId: Joi.string().required(),
        inTopic: Joi.string().required(),
        outTopic: Joi.string().required(),
        retryTopic: Joi.string().optional(),
        format: Joi.string().optional(),
        heartbeatInterval: Joi.number().default(6000),
        fromBeginning: Joi.boolean().default(false),
    }).required(),
    pat: Joi.object().optional(),
    retryable: Joi.string().optional(),
    before: Joi.string().optional(),
    after: Joi.string().optional(),
});
/**
 * Convert header keys to lowercase, ByteArray => string
 * @param headers
 * @return {{}}
 */
function convertHeaders(headers) {
    if (_.isEmpty(headers)) return {};
    const res = {};
    Object.keys(headers).forEach((k) => res[k.toLowerCase()] = headers[k].toString());
    return res;
}
class KafkaConnector extends Connector {
    constructor(cConfig) {
        super(cConfig);
        const valid = kafkaConfigSchema.validate(cConfig, { abortEarly: false, allowUnknown: true });
        if (valid.error) {
            logger.error(`Invalid config for kafka connector ${cConfig.name}: ${(valid?.error?.details ?? []).map((d) => d.message).join(' ')}`);
        }
        this.type = 'kafka';
        const kafka = new Kafka(cConfig?.kafka?.config ?? {});
        logger.info('Starting kafka connector');
        this.accountsClient = new SecretsClient('');
        this.producer = new Producer(kafka);
        // maxQueueSize and maxParallel are global settings
        this.consumer = new Consumer(kafka, {
            retryTopic: cConfig.kafka.retryTopic,
            fromBeginning: cConfig.kafka.fromBeginning,
            heartbeatInterval: cConfig.kafka.heartbeatInterval,
            // TODO allow queue size, message size etc ?
        });
    }

    /**
     * Look for JWT in headers or default to PAT provided in kafka configs
     * @param headers
     * @return {Promise<*>}
     */
    async authToken(headers) {
        let shadowToken;
        // Get shadow token from headers
        if (_.has(headers, 'token')) {
            shadowToken = headers.token;
        }
        if (_.has(headers, 'authorization')) {
            const tokens = headers.authorization.split(' ');
            if (tokens.length === 2 && tokens[0].toLowerCase() === 'bearer') {
                [, shadowToken] = tokens;
            }
        }
        // Convert shadow token to fat token
        if (shadowToken) {
            return this.accountsClient.fetchFatToken(shadowToken);
        }
        if (!this.cConfig.pat) {
            throw Error(`Unauthorized: JWT not provided from headers nor a "pat" defined in the "${this.cConfig.name}" connector config`);
        }
        return this.accountsClient.genFetchToken(this.cConfig.pat);
    }

    async toSynapseMessage({ value, headers }) {
        const request = JSON.parse(value); // Must be JSON
        const lowerHeaders = convertHeaders(headers);
        const token = await this.authToken(lowerHeaders);
        const username = parseJwt(token)?.payload?.sub; // Producer might provide this per request
        const {
 projectId, agentName, serviceName, payload, properties, correlationId, sessionId, 
} = request;
        const FQAgentName = QualifiedName.fromString(agentName, false).toString();
        // Add connector callback, so we can send a message upon completion
        const newProperties = _.set(properties || {}, 'callbackUrl', `connector://${this.cConfig.name}/`);
        return {
            agentName: FQAgentName,
            correlationId,
            headers: lowerHeaders,
            payload,
            projectId,
            properties: newProperties,
            serviceName,
            sessionId,
            sync: true,
            token,
            username,
        };
    }

    async start(workerPool) {
        await this.producer.start();
        const onData = async (kafkajsMsg) => {
            try {
                const invokeMsg = await this.toSynapseMessage(kafkajsMsg);
                return workerPool.run(invokeMsg);
            } catch (err) {
                const json = parseIfJSON(kafkajsMsg.value.toString());
                return this.handleCallBack({ correlationId: json?.correlationId }, {
                    message: err.message,
                    originalMessage: json,
                }, ERROR);
            }
        };
        await this.consumer.start({
            groupId: this.cConfig.kafka.groupId,
            topicsList: [this.cConfig.kafka.inTopic],
            onData,
            autoCommit: false, // Do not autocommit allow consumer to commit at aend of activation
        });
    }

    async stop() {
        return this.consumer.stop();
    }

    async handleCallBack(synapseMsg, response, status) {
        const respMesg = {
            activationId: synapseMsg.requestId,
            correlationId: synapseMsg.correlationId,
            response,
            status,
        };
        const reply = this.producer.produce({
            topic: this.cConfig.kafka.outTopic,
            messages: [{
                    // key ??
                    // headers ??
                    value: JSON.stringify(respMesg),
                }],
        });
        let retryMesg = {};
        // if retryTopic is defined send error there as well.
        if (this.cConfig.kafka.retryTopic && status === ERROR) {
            retryMesg = this.producer.produce({
                topic: this.cConfig.kafka.retryTopic,
                messages: [{
                        // key ??
                        headers: { originalTopic: this.cConfig.kafka.inTopic, ...synapseMsg.headers },
                        value: JSON.stringify({ ...respMesg, payload: synapseMsg.payload }),
                    }],
            });
        }
        return Promise.all([reply, retryMesg]);
    }
}
export { KafkaConnector };
export default {
    KafkaConnector,
};
