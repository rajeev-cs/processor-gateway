import config from 'config';
import { getLogger } from '@tt-sensa/sensa-express-common';

const logger = getLogger(config.get('name'), config.get('logging'));
/* Idea copied from https://github.com/yonigo/kafkajs-wrapper */
class Producer {
    constructor(kafkaClient) {
        this.ready = false;
        this.kafkaProducer = undefined;
        this.kafkaClient = kafkaClient;
    }

    async start() {
        if (this.ready) return;
        if (!this.kafkaProducer) {
            this.kafkaProducer = this.kafkaClient.producer();
            this.kafkaProducer.on('producer.disconnect', () => {
                // Set ready to false, so we can trigger reconnects as needed...
                this.ready = false;
            });
        }
        await this.kafkaProducer.connect();
        logger.info('Kafka Producer is Ready');
        this.ready = true;
    }

    async produce({ topic, messages }) {
        if (!this.ready) {
            await this.start();
        }
        const toProcess = (!Array.isArray(messages) ? [messages] : messages).map((m) => {
            const { value, headers, key } = m;
            return { value, headers, key };
        });
        await this.kafkaProducer.send({
            acks: config.acks,
            topic,
            messages: toProcess,
        });
        logger.debug(`Kafka Producer sent message msg to topic ${topic}`);
    }

    async produceBulkMsg({ topic, messages }) {
        return this.produce({ topic, messages });
    }
}
export { Producer };
export default {
    Producer,
};
