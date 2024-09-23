// eslint-disable-next-line max-classes-per-file
class Producer {
    constructor({ client, sendCb }) {
        this.client = client;
        this.sendCb = sendCb;
    }

    async connect() {
        return Promise.resolve();
    }

    async send({ topic, messages }) {
        if (!this.client.topicMessages[topic]) {
            this.client.topicMessages[topic] = [];
        }
        this.client.topicMessages[topic].push(...messages);
        this.sendCb({ topic, messages });
    }

    async disconnect() {
        return Promise.resolve();
    }

    on(event, fn) {
        // eslint-disable-next-line no-console
        console.log(event, fn);
    }
}
class Consumer {
    constructor({ groupId, subscribeCb }) {
        this.groupId = groupId;
        this.subscribeCb = subscribeCb;
    }

    getGroupId() {
        return this.groupId;
    }

    async connect() {
        return Promise.resolve();
    }

    async subscribe({ topic }) {
        this.subscribeCb(topic, this);
    }

    async run({ eachMessage, eachBatch }) {
        this.eachMessage = eachMessage;
        this.eachBatch = eachBatch;
    }

    // eslint-disable-next-line no-unused-vars, no-empty-function,@typescript-eslint/no-unused-vars
    async pause(list) { 
        throw TypeError('Not implemented');
    }

    // eslint-disable-next-line no-unused-vars, no-empty-function,@typescript-eslint/no-unused-vars
    async resume(list) {
        throw TypeError('Not implemented');
    }

    async disconnect() {
        return Promise.resolve();
    }
}
class Kafka {
    constructor(config) {
        this.brokers = config.brokers;
        this.clientId = config.clientId;
        this.topics = {};
        // Store messages from producer so we can track what got sent...
        this.topicMessages = {};
    }

    _subscribeCb(topic, consumer) {
        this.topics[topic] = this.topics[topic] || {};
        const topicObj = this.topics[topic];
        topicObj[consumer.getGroupId()] = topicObj[consumer.getGroupId()] || [];
        topicObj[consumer.getGroupId()].push(consumer);
    }

    _sendCb({ topic, messages }) {
        if (!this.topics[topic]) {
            return;
        }
        Object.values(this.topics[topic]).forEach((consumerGroup) => {
            consumerGroup.forEach((consumer) => consumer.eachBatch(
            // TODO should we add heartbeat/isRunning false to test "retries"
            {
                batch: { messages },
                heartbeat: () => { },
                isRunning: () => true,
                resolveOffset: () => { },
                commitOffsetsIfNecessary: () => { },
            }));
        });
        // messages.forEach((message) => {
        //     Object.values(this.topics[topic]).forEach((consumers) => {
        //         const consumerToGetMessage = Math.floor(Math.random() * consumers.length);
        //         consumers[consumerToGetMessage].eachMessage({
        //             message,
        //         });
        //     });
        // });
    }

    producer() {
        return new Producer({
            client: this,
            sendCb: this._sendCb.bind(this),
        });
    }

    consumer({ groupId }) {
        return new Consumer({
            groupId,
            subscribeCb: this._subscribeCb.bind(this),
        });
    }
}
export { Kafka };
export default {
    Kafka,
};
