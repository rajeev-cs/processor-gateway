import async from 'async';
import config from 'config';
import { getLogger } from '@tt-sensa/sensa-express-common';
import { Producer } from './producer.js';
import commitManager from './commitManager.js';

const logger = getLogger(config.get('name'), config.get('logging'));
const MaxParallelDefault = config?.kafka?.maxParallelHandles ?? 25;
const MaxQueueSize = config?.kafka?.maxQueueSize ?? 50; // Maximum # on simultaneous messages
const MaxBytesPerPartition = config?.kafka?.maxBytesPerPartition ?? 1048576;
/* Idea copied from https://github.com/yonigo/kafkajs-wrapper */
class Consumer {
    constructor(kafkaClient, {
 retryTopic, commitInterval, maxParallel, maxQueueSize, fromBeginning, heartbeatInterval, maxBytesPerPartition, 
}) {
        this.kafkaClient = kafkaClient;
        this.ready = false;
        this.paused = false;
        this.retryTopic = retryTopic;
        this.kafkaConsumer = undefined;
        this.commitInterval = commitInterval || 5000;
        this.heartbeatInterval = heartbeatInterval || 6000;
        this.maxQueueSize = maxQueueSize || MaxQueueSize; // Maximum messages inflight
        this.fromBeginning = fromBeginning || false;
        this.maxBytesPerPartition = maxBytesPerPartition || MaxBytesPerPartition;
        // Is maxParallel supplied or the system has a configured default, enable async queue to provide backpressure
        if (maxParallel || (MaxParallelDefault && MaxParallelDefault > 0)) {
            this.maxParallel = maxParallel || MaxParallelDefault;
            this.msgQueue = async.queue(async (data, done) => {
                await this.handleCB(data, this.onData);
                done();
            }, this.maxParallel);
            this.msgQueue.drain(async () => {
                if (this.paused) this.retryResume();
            });
        }
    }

    // Some silly helper functions, so I can spy() for tests
    pause() {
        logger.debug(`Pausing consumer Queue size: ${this.msgQueue.length()} ${JSON.stringify(this.topicsList)}`);
        this.paused = true;
    }

    // Some silly helper functions, so I can spy() for tests
    resume() {
        logger.debug(`Resumed consumer ${JSON.stringify(this.topicsList)}`);
        this.paused = false;
    }

    isPaused() {
        return this.paused;
    }

    async start({
 groupId, topicsList, onData, 
    //        onError,
    autoCommit, 
}) {
        if (this.ready) return;
        if (!topicsList) throw Error('Cannot start without a topic list');
        this.topicsList = topicsList;
        this.onData = onData || this.onData;
        //      this.onError = onError || this.onError;
        this.autoCommit = autoCommit || false;
        const consumerConfig = {
            groupId,
            maxBytesPerPartition: this.maxBytesPerPartition,
            heartbeatInterval: this.heartbeatInterval,
        };
        this.kafkaConsumer = this.kafkaClient.consumer(consumerConfig);
        await this.kafkaConsumer.connect();
        topicsList.forEach((t) => {
            this.kafkaConsumer.subscribe({ topic: t, fromBeginning: this.fromBeginning });
        });
        // If I have provided a retryTopic create a producer to write "retry" messages.
        if (this.retryTopic) {
            this.retryProducer = new Producer(this.kafkaClient);
            await this.retryProducer.start();
        }
        commitManager.start(this.kafkaConsumer, { commitInterval: this.commitInterval });
        this.ready = true;
        logger.info(`Kafka consumer ready ${topicsList} retryTopic: ${this.retryTopic || '<NOT SET>'}`);
        const onEachMessage = async ({ topic, partition, message }) => {
            message.partition = partition || 0; // default partition to 0
            message.topic = topic;
            logger.debug(`message received from kafka,partition: ${message.partition}, offset: ${message.offset}`);
            if (this.maxParallel) {
                this.msgQueue.push(message);
                if (this.msgQueue.length() > this.maxQueueSize && !this.isPaused()) {
                    try {
                        this.kafkaConsumer.pause(this.topicsList.map((t) => ({ topic: t })));
                    } catch (e) {
                        logger.error('Unable to pause kafka connector', e);
                    } finally {
                        this.pause();
                    }
                }
            } else {
                this.handleCB(message, this.onData);
            }
        };
        const onMessageBatch = async ({
 batch, resolveOffset, commitOffsetsIfNecessary, heartbeat, isRunning, 
}) => {
            commitManager.setPartitionCBs({
                partition: batch.partition || 0, resolveOffset, commitOffsetsIfNecessary, heartbeat, isRunning,
            });
            batch.messages.forEach((message) => {
                onEachMessage({ topic: batch.topic, partition: batch.partition || 0, message });
            });
        };
        await this.kafkaConsumer.run({
            // eachMessage: onEachMessage, << eachMessage ~= autocommit don't use..
            eachBatch: onMessageBatch,
        });
    }

    async handleCB(data, handler) {
        try {
            try {
                commitManager.notifyStartProcessing(data);
                await handler(data);
            } catch (e) {
                logger.error(`Kafka consumer error: ${e}`);
                if (this.retryTopic) {
                    data.headers = data.headers || {};
                    // Store original topic for reference before moving message to retryTopic
                    data.headers.originalTopic = data.topic;
                    await this.retryProducer.produce({
                        topic: this.retryTopic,
                        messages: data,
                    });
                }
            }
        } catch (e) {
            logger.error(`Error producing to retry: ${e}`);
        } finally {
            commitManager.notifyFinishedProcessing(data);
        }
    }

    async onData(data) {
        logger.debug(`Handling received message with offset: ${data.offset}`);
        return Promise.resolve();
    }

    // Sometimes resume fails due to re-balance. we need to retry until success
    async retryResume() {
        const maxResumeRetries = 5;
        let tryNum = 0;
        let interval;
        async function helper() {
            tryNum += 1;
            if (tryNum > maxResumeRetries) {
                logger.error('Unable to resume consumption');
                process.kill(process.pid);
            }
            if (this.isPaused()) {
                try {
                    if (!this.autoCommit) await commitManager.commitProcessedOffsets(true);
                    this.kafkaConsumer.resume(this.topicsList.map((t) => ({ topic: t })));
                    this.resume();
                    clearInterval(interval);
                } catch (e) {
                    logger.error(`Resume err ${e}`);
                }
            } else {
                clearInterval(interval);
            }
        }
        interval = setInterval(helper.bind(this), 500);
        helper.call(this);
    }
}
export { Consumer };
export default {
    Consumer,
};
