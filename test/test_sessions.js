/* eslint-disable @typescript-eslint/no-unused-expressions */
import config from 'config';
import { expect } from 'chai';
import assert from 'assert';
import Redis from 'ioredis';
import { mockLogger } from './testutil/index.js';
import { SessionController } from '../lib/controllers/sessions.controller.js';
import { makeKey } from '../lib/controllers/sessions.js';
const projectId = 'sessionproj';

describe('Cortex Sessions', () => {
    let redisClient;
    let sessionCtrl;
    before(async () => {
        redisClient = new Redis(config.redis.uri);
        sessionCtrl = new SessionController({ logger: mockLogger(), redis: redisClient });
    });
    beforeEach(async () => {
        await redisClient.flushdb();
    });
    after(async () => {
        await redisClient.disconnect();
    });
    it('should return created sessions stored in redis', async () => {
        const sessionId = 'sestest';
        await redisClient.hset(makeKey(projectId, sessionId), {
            'bar.buzz': '"blah"',
            'boo.buzz': '"blah2"',
            'boo.buzz.baz': '"blah3"',
        });
        const json = await sessionCtrl.getSession(projectId, sessionId);
        expect(json).to.have.property('state').to.have.property('bar.buzz', 'blah');
        expect(json).to.have.property('state').to.have.property('boo.buzz', 'blah2');
        expect(json).to.have.property('state').to.have.property('boo.buzz.baz', 'blah3');
    });
    it('should return empty state for non-existing session', async () => {
        const sessionId = 'noExist';
        const json = await sessionCtrl.getSession(projectId, sessionId);
        // eslint-disable-next-line no-unused-expressions
        expect(json).to.have.property('state').to.be.empty;
    });
    it('should update a session with additional information', async () => {
        const sessionId = 'updates';
        await redisClient.hset(makeKey(projectId, sessionId), 'orig', 'value');
        const state = { somekey: 'somevalue', somekey2: 'somevalue2' };
        await sessionCtrl.updateSession(projectId, sessionId, state);
        const keys = await redisClient.hgetall(makeKey(projectId, sessionId));
        // orig from test setup + 2 more
        assert.strictEqual(Object.keys(keys).length, 3, 'Expect 3');
    });
    it('should store fetch different JSON types', async () => {
        const sessionId = 'types';
        const state = {
            string: 'str values',
            number: 99999,
            double: 999.99,
            bool: true,
            array: [1, 2, '444', { a: 'cc' }],
            badJSON: '{ this is a test',
            empty: '',
            obj: {
                a: 1,
                b: 'c',
                c: [1],
                d: { e: 'f' },
            },
        };
        await sessionCtrl.updateSession(projectId, sessionId, state);
        const keys = await redisClient.hgetall(makeKey(projectId, sessionId));
        // orig from test setup + 2 more
        assert.strictEqual(Object.keys(keys).length, 8, 'Expect 8');
        const json = await sessionCtrl.getSession(projectId, sessionId);
        expect(json.state).to.deep.equal(state);
    });

    // it('should validate session config', async () => {
    //     const sessionId = 'bar';
    //      = { bad: 'bad', ttl: 'NOT NUMBER' };
    //     await sessionCtrl.createSession(req, res);
    //     const resJson = checkResponse(res, 400);
    //     expect(resJson).to.have.property('details').with.length(1, 'one detail');
    // });

    it('should create session with initial state', async () => {
        const sessionId = 'initsess';
        const body = {
            sessionId, ttl: 100, state: { initval: 'initme' }, description: 'Description',
        };
        await sessionCtrl.createSession(projectId, body);
        const getSessionJson = await sessionCtrl.getSession(projectId, sessionId);
        expect(getSessionJson).to.have.property('state').to.haveOwnProperty('initval').equal('initme');
        expect(getSessionJson).to.have.property('ttl').equal(100);
        expect(getSessionJson).to.have.property('description').equal('Description');
    });
    it('should create session with initial empty state', async () => {
        const sessionId = 'initsess';
        const body = {
            sessionId, ttl: 100, state: {}, description: 'Description',
        };
        await sessionCtrl.createSession(projectId, body);
        const getSessionJson = await sessionCtrl.getSession(projectId, sessionId);
        // eslint-disable-next-line no-unused-expressions
        expect(getSessionJson).to.have.property('state').to.be.empty;
    });
    //    let sessionId = 'not-set-from-test';
    it('should start a session with a shortTTL', async () => {
        const body = {
            ttl: 60,
            description: 'session for testing',
        };
        const createSessionJson = await sessionCtrl.createSession(projectId, body);
        expect(createSessionJson).to.have.property('sessionId');
        const { sessionId } = createSessionJson;
        const getSessionJson = await sessionCtrl.getSession(projectId, sessionId);
        expect(getSessionJson).to.have.property('description');
        expect(getSessionJson).to.have.property('ttl');
        // eslint-disable-next-line no-unused-expressions
        expect(getSessionJson).to.have.property('state').empty;
    });

    it('should create/get an anonymous session', async () => {
        const sessionId = 'amAnonymous';
        const state = { am: 'anonymous' };
        await sessionCtrl.updateSession(projectId, sessionId, state);
        const getSessionJson = await sessionCtrl.getSession(projectId, sessionId);
        expect(getSessionJson).to.have.property('description');
        expect(getSessionJson).to.have.property('ttl');
        // eslint-disable-next-line no-unused-expressions
        expect(getSessionJson).to.have.property('state').not.empty;
    });
    it('should update a session with obj of additional information', async () => {
        const sessionId = 'updateMe';
        //  set one key ensure value changes
        await redisClient.hset(makeKey(projectId, sessionId), 'somekey', 'blah');
        const state = {
                somekey: 'somevalue',
                otherkey: 'othervalue',
        };
        await sessionCtrl.updateSession(projectId, sessionId, state);
        const keys = await redisClient.hgetall(makeKey(projectId, sessionId));
        expect(Object.keys(keys)).to.have.length(2, 'Expect 2');
    });
    it('should return the ALL keys of a particular session', async () => {
        const sessionId = 'allofme';
        // JSON encoded values!!
        await redisClient.hset(makeKey(projectId, sessionId), 'buz', '"blah"');
        await redisClient.hset(makeKey(projectId, sessionId), 'somekey', '5');
        const resJson = await sessionCtrl.getSession(projectId, sessionId);
        expect(resJson).to.have.property('state').to.have.property('buz', 'blah');
        expect(resJson).to.have.property('state').to.have.property('somekey', 5);
        expect(resJson).to.have.property('description');
        expect(resJson).to.have.property('ttl');
    });
    it('should return the a specific key of a particular session', async () => {
        const sessionId = 'onekey';
        // JSON Encoded...
        await redisClient.hset(makeKey(projectId, sessionId), 'buzz', '"blah"');
        await redisClient.hset(makeKey(projectId, sessionId), 'somekey', 5);
        const key = 'buzz';
        const resJson = await sessionCtrl.getSession(projectId, sessionId, key);
        expect(resJson).to.have.property('state').to.have.property('buzz', 'blah');
        expect(resJson).to.have.property('state').to.not.have.property('somekey', 5);
    });
    it('should return 400 for bad update', async () => {
        const sessionId = 'badupdates';
        await Promise.all([
            {},
            { state: {} },
            { state: [] },
            { state: 'bad state' },
            { state: ['bad state'] },
            { state: [{ key: 'key', value: 'bad state' }] },
            { state: 9999 },
            { state: false },
        ].map(async ({ state }) => {
//            req.query = { key: 'buzz' };
            try {
                await sessionCtrl.updateSession(projectId, sessionId, state);
                assert.fail();
            } catch (err) {
                expect(err).to.haveOwnProperty('output').haveOwnProperty('statusCode').equal(400);
            }
        }));
    });
    it('should be able to stop/delete session', async () => {
        const sessionId = 'delme';
        await redisClient.set(makeKey(projectId, sessionId, 'buzz'), 'blah');
        await sessionCtrl.deleteSession(projectId, sessionId);
        const keys = await redisClient.get(makeKey(projectId, sessionId));
        // eslint-disable-next-line no-unused-expressions
        expect(keys).to.be.null;
    });
    it('404 for missing stop/delete session', async () => {
        const sessionId = 'nothere';
        try {
            await sessionCtrl.deleteSession(projectId, sessionId);
            assert.fail();
        } catch (err) {
            expect(err).to.haveOwnProperty('output').haveOwnProperty('statusCode').equal(404);
        }
    });
    it('should list sessions', async () => {
        await redisClient.hset(makeKey(projectId, 'list1'), {
            'bar.buzz': '"blah"',
            'boo.buzz': '"blah2"',
            'boo.buzz.baz': '"blah3"',
        });
        await redisClient.hset(makeKey(projectId, 'list2'), {
            'bar.buzz': '"blah"',
            'boo.buzz': '"blah2"',
            'boo.buzz.baz': '"blah3"',
            'sess.descr': '"This is a descr"',
        });
        await redisClient.hset(makeKey(projectId, 'list3'), {
            'bar.buzz': '"blah"',
            'sess.descr': '"This is a descr"',
            'sess.ttl': '55',
        });
        await redisClient.hset(makeKey('otherproj', 'listother'), {
            'bar.buzz': '"blah"',
        });
        const json = await sessionCtrl.listSessions(projectId);
        // eslint-disable-next-line no-unused-expressions
        expect(json.sessions.find((s) => s.sessionId === 'list1')).to.have.property('description').to.be.null;
        expect(json.sessions.find((s) => s.sessionId === 'list2')).to.have.property('description').equal('"This is a descr"');
        expect(json.sessions.find((s) => s.sessionId === 'list3')).to.have.property('description').equal('"This is a descr"');
        // eslint-disable-next-line no-unused-expressions
        expect(json.sessions.find((s) => s.sessionId === 'listother')).to.be.undefined;
    });
    it('should list sessions honoring limit param', async () => {
        await redisClient.hset(makeKey(projectId, 'list1'), {
            'bar.buzz': '"val1"',
            'sess.ttl': '50',
            'sess.descr': '"This is a descr"',
        });
        await redisClient.hset(makeKey(projectId, 'list2'), {
            'bar.buzz': '"val2"',
            'sess.ttl': '55',
            'sess.descr': '"This is a descr"',
        });
        await redisClient.hset(makeKey(projectId, 'list3'), {
            'bar.buzz': '"val3"',
            'sess.descr': '"This is a descr"',
            'sess.ttl': '100',
        });
        const json = await sessionCtrl.listSessions(projectId, 2);
        expect(json.sessions.length).to.equal(2);
    });
});
