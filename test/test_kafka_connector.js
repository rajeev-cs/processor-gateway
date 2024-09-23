import assert from 'assert';
import { setTimeout } from 'timers/promises';
import sinon from 'sinon';
import { Kafka } from './kafkajs.js';
import kafkaWrapper from '../lib/connectors/kafka/kafkaWrapper/index.js';
import { waitUntil } from './testutil/index.js';

const { Consumer, Producer } = kafkaWrapper;

let kafka;
describe('Test kafkajs wrappers', () => {
    const sandbox = sinon.createSandbox();
    before(async () => {
        kafka = new Kafka({
            clientId: 'my-app',
            brokers: ['localhost:9092'],
        });
    });
    after(async () => {
        // clean up mocks that may not have been called
        // await redisServer.stop();
    });
    beforeEach(() => {
        sandbox.spy(Consumer.prototype);
    });
    afterEach(() => {
        sandbox.restore();
    });
    it('Test producer/consumer wrapper', async () => {
        const con = new Consumer(kafka, {});
        const recieved = [];
        const onData = async (msg) => recieved.push(msg);
        await con.start({
            groupId: 'grp', topicsList: ['foo'], autoCommit: false, onData,
        });
        const prod = new Producer(kafka);
        await prod.start();
        await prod.produce({ topic: 'foo', messages: [{ value: 'sdsdsdsdsdsdsd' }, { value: 'xxxxxxxxxxxxxxxxxx' }] });
        // assert(recieved.length === 2);
    }).timeout(20000);
    it('Test producer/consumer pause', async () => {
        // set queue size/max parallel lower to trigger pause/resume..
        const con = new Consumer(kafka, { maxParallel: 5, maxQueueSize: 5 });
        const res = [];
        const onData = async (msg) => {
            await setTimeout(20);
            res.push(msg);
        };
        await con.start({
            groupId: 'grp', topicsList: ['foo'], autoCommit: false, onData,
        });
        const prod = new Producer(kafka);
        await prod.start();
        await Promise.all([...Array(20)].map(() => prod.produce({
            topic: 'foo',
            messages: [{ value: 'sdsdsdsdsdsdsd' }, { value: 'xxxxxxxxxxxxxxxxxx' }],
        })));
        await waitUntil(() => res.length === 40);
        assert(Consumer.prototype.pause.called);
        assert(Consumer.prototype.retryResume.called);
        // TODO why does queue size increase ??
    }).timeout(20000);
    it('Test consumer errors', async () => {
        // set queue size/max parallel lower to trigger pause/resume..
        const con = new Consumer(kafka, { retryTopic: 'retryme' });
        const res = [];
        const onData = async (msg) => {
            const value = msg.value.toString();
            const num = parseInt(value, 10);
            res.push(msg);
            if (num % 2 !== 0) {
                throw Error('No odds allowed');
            }
        };
        await con.start({
            groupId: 'grp', topicsList: ['foo'], autoCommit: false, onData,
        });
        const prod = new Producer(kafka);
        await prod.start();
        await Promise.all([...Array(20)].map((_, i) => prod.produce({
            topic: 'foo',
            messages: [{ value: `${i}` }],
        })));
        await waitUntil(() => res.length === 20);
        assert.ok(kafka.topicMessages.retryme.length === 10);
    }).timeout(10000);
});
