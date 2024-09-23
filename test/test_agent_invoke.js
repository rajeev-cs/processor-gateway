/* eslint-disable @typescript-eslint/no-unused-expressions */
import _ from 'lodash';
import config from 'config';
import chai from 'chai';
import assert from 'node:assert';
import * as mocks from 'node-mocks-http';
import mongoose from 'mongoose';
import nock from 'nock';
import { setTimeout } from 'timers/promises';
import Redis from 'ioredis';
import Assert from 'assert';
import qs from 'qs';
import request from 'supertest';
import { waitUntil, getAuthHeader, getToken } from './testutil/index.js';
import { container } from '../lib/ioc.js';
import { TaskCtrl } from '../lib/controllers/tasks.js';
import { createEventHandler } from '../lib/events/handler.js';
import {
 COMPLETE, ERROR, STARTED, PENDING,
} from '../lib/state/abstractStateStore.js';
import { AgentController } from '../lib/controllers/agent.controller.js';
import server from '../lib/server.js';
import Infra from '../lib/interfaces/Infra.js';
import { Synapse } from '../lib/synapse.js';
import { RuntimeProvider } from '../lib/actions/runtimeProvider.ts';

const JWT = getToken();
const TESTUSER = 'test-user@example.com';
const events = [];
const projectId = 'cogscale';
const supertest = request(server.app);
// Turn on log output for test if DEBUG env var is set.. to reduce noise...

let taskCtrl;
function genJobCallBack(state) {
    // use function NOT => as nock binds "this" ...
    // eslint-disable-next-line func-names
    return async function (uri, requestBody, cb) {
        const pathSegs = _.split(this.req.options.pathname, '/');
        const reqOptions = {
            params: {
                activationId: pathSegs[3],
                channelId: pathSegs[4],
            },
            query: { state },
            headers: this.req.headers,
            body: requestBody,
        };
        const { req, res } = mocks.createMocks(reqOptions);
        await taskCtrl.taskCallBack(req, res);
        cb(null, [200, 'NO good']);
    };
}

describe('agent & skill invoke', () => {
    let agentCtrl;
    let synapse;
    let callBackUrl;
    let eventHandler;
    let redisClient;

    async function waitChannelId() {
        await waitUntil(() => callBackUrl !== '');
        return callBackUrl.split('/')
            .slice(-1)[0];
    }

    const  agentInvokeUrl = (projectI, agentName, serviceName, query = undefined) => `/fabric/v4/projects/${projectId}/agentinvoke/${encodeURIComponent(agentName)}/services/${serviceName}?${qs.stringify(query)}`;
    const skillInvokeUrl = (proj, skillName, inputName, query = undefined) => `/fabric/v4/projects/${proj}/skillinvoke/${encodeURIComponent(skillName)}/inputs/${inputName}?${qs.stringify(query)}`;

    async function waitAgentState(activationId, wantedState = PENDING) {
        assert.notEqual(activationId, undefined);
        const state = await synapse.statestore.get(activationId);
        if (state?.status === undefined || state.status !== wantedState) {
            await setTimeout(50);
            return waitAgentState(activationId, wantedState);
        }
        return state;
    }

    /**
     *  Wait for agent to complete if status != PENDING
     *  Check for transits if ERROR|COMPLETE
     *  compare events if provided
     * @param activationId
     * @param status
     * @param expEvents
     * @param query params used to detect sync mode
     * @return {Promise<*|boolean>}
     */
    async function checkState(activationId, wantedStatus, expEvents, query) {
        await waitAgentState(activationId,  wantedStatus); // wait for status
        const state = await synapse.statestore.get(activationId);
        if (wantedStatus === PENDING) {
            return state;
        }
        if (state.status !== ERROR) {
            // eslint-disable-next-line no-unused-expressions
            chai.expect(_.every(Object.values(state.transits), ['status', COMPLETE]), 'Expect all transits done').to.be.true;
        }
        if (state.agentName) {
            // Agents should have a plan attached
            chai.expect(state.plan)
                .to
                .have
                .ownProperty('nodes');

            // Check state includes Agent metadata
            // eslint-disable-next-line no-unused-expressions
            chai.expect(state.agentTitle).to.not.be.undefined;
            chai.expect(state.plan.agentName).to.equal(state.agentName);
            chai.expect(state.plan.agentTitle).to.equal(state.agentTitle);

            // There shouldn't be any references to a Skill
            // eslint-disable-next-line no-unused-expressions
            chai.expect(state.skillName).to.be.undefined;
            // eslint-disable-next-line no-unused-expressions
            chai.expect(state.skillTitle).to.be.undefined;
            chai.expect(state.plan.skillName).to.equal(state.skilltName);
            chai.expect(state.plan.skillTitle).to.equal(state.skillTitle);
        }

        if (state.skillName) {
            // Skill invocations should not have a plan
            // eslint-disable-next-line no-unused-expressions
            chai.expect(state.plan).to.be.undefined;

            // Check state includes Skill metadata (no need to check plan)
            // eslint-disable-next-line no-unused-expressions
            chai.expect(state.skillName).to.not.be.undefined;
            // eslint-disable-next-line no-unused-expressions
            chai.expect(state.skillTitle).to.not.be.undefined;

            // There shouldn't be any references to an Agent (no need to check plan)
            // eslint-disable-next-line no-unused-expressions
            chai.expect(state.agentName).to.be.undefined;
            // eslint-disable-next-line no-unused-expressions
            chai.expect(state.agentTitle).to.be.undefined;
        }
        chai.expect(state.transits)
            .to
            .have
            .length
            .above(0);
        chai.expect(state.channelId)
            .to
            .be
            .a('string');
        // We should have 0 states STARTED
        chai.expect(state.transits.filter((t) => t.status === STARTED))
            .to
            .have
            .length(0);
        chai.expect(state.status, `Expect ${wantedStatus} status`)
            .to
            .be
            .equal(wantedStatus, `State expected ${wantedStatus} not ${state.status}`);
        if (expEvents) {
            chai.expect(events.filter((e) => e.activationId === activationId)
                .map((e) => e.eventType)
                .sort())
                .to
                .deep
                .equal(expEvents.sort());
        }
        if (query?.sync) {
            // eslint-disable-next-line no-unused-expressions
            chai.expect(state.response).to.not.be.empty;
        }
        return state;
    }

    before(async () => {
        if (!nock.isActive()) {
            nock.activate();
        }
        redisClient = new Redis(config.redis.uri);
        eventHandler = createEventHandler({ redis: redisClient });
        eventHandler.addListener({ processEvent: (msg) => events.push(msg) });
        const infra = container.get < Infra > (Infra);
        synapse = container.get < Synapse > (Synapse);
        const runtimeProvider =  container.get < RuntimeProvider > (RuntimeProvider);
        await mongoose.connect(config.get('mongo.uri'), config.get('mongo.options'));
        // cb is only for testing purposes
        runtimeProvider.cb = (url) => {
            console.debug(`Callback ${url}`);
            callBackUrl = url;
        };
        taskCtrl = new TaskCtrl(infra, synapse);
        agentCtrl = new AgentController(infra, synapse, taskCtrl);
    });

    after(async () => {
        // clean up mocks that may not have been called
        nock.cleanAll();
        redisClient.disconnect();
    });

    beforeEach(() => {
        callBackUrl = '';
        events.splice(0, events.length);
    });

    it('check plan exists in pending activation', async () => {
        const agentName = 'cortex/hubble_agent';
        const serviceName = 'input';
        const body = { payload: { text: 'Job Payload' } };
        const { _body: resp } = await supertest
        .post(agentInvokeUrl(projectId, agentName, serviceName))
            .set('Authorization', getAuthHeader())
            .send(body)
            .expect(200);
        const state = await checkState(resp.activationId, PENDING);
        chai.expect(state).to.haveOwnProperty('plan');
    });
    // Expect immediate error for invalid skill input
    it('Skill invoke bad input', async () => {
        const skillName =  'good-skill';
        const inputName = 'nothere';
        const body = {
                payload: { text: 'Job Payload' },
                properties: { some: 'prop' },
            };
        const { _body: respBody } = await supertest
            .post(skillInvokeUrl(projectId, skillName, inputName))
            .set('Authorization', getAuthHeader())
            .send(body)
            .expect(400);
        chai.expect(respBody)
            .to
            .have
            .property('message')
            .to
            .equal('Input "nothere" not found in skill definition');
    });
    it('Test generate agent diagram', async () => {
        const body = await agentCtrl.agentPlanDiagram(projectId, 'agentMerge-middle', 'input');
        chai.expect(body)
            .to
            .have
            .property('plan');
        chai.expect(body)
            .to
            .have
            .property('dotNotation');
    });
    describe('daemon agents async and async', () => {
        const QUERIES = [
            {
                name: 'empty',
                query: {},
            },
            {
                name: 'empty-sync',
                query: { sync: true },
            },
        ];
        QUERIES.forEach((testReq) => {
        // const testReq = QUERIES[1];
            it(`single daemon ${testReq.name}`, async () => {
                const agentName = 'cortex%2Fbusyboxagent';

                const { _body: { activationId, response } } = await supertest
                    .post(agentInvokeUrl(projectId, agentName, 'input', testReq.query))
                    .set('Authorization', getAuthHeader())
                    .send({ payload: { text: 'Payload' } });
                await checkState(activationId, COMPLETE, ['agent.input', 'skill.input', 'skill.output', 'agent.output'], testReq.query);
                if ( testReq?.data?.query?.sync) {
                    chai.expect(response).to.not.be.undefined('', 'No response');
                }
                await supertest
                    .post(`/fabric/v4/projects/${projectId}/activations/${activationId}/cancel`)
                    .set('Authorization', getAuthHeader())
                    .expect(200);
                // Cancelling a completed activation should just return a 200..
                const { _body: activation } = await supertest
                    .get(`/fabric/v4/projects/${projectId}/activations/${activationId}`)
                    .set('Authorization', getAuthHeader());
                // Cancelling a completed task shouldn't change status
                chai.expect(activation).to.have.property('status').equal(COMPLETE);

            });
            it(`single daemon with finally ${testReq.name}`, async () => {
                nock('http://cogscale-nock-skill-nock-good.cortex.svc.cluster.local:8080')
                    .matchHeader('Content-type', 'application/json')
                    .post('/myapi')
                    .reply(200, { payload: { text: 'called' } });
                const agentName = 'cortex/busyboxagent-finally';
                const { _body: { activationId, response } } = await supertest
                    .post(agentInvokeUrl(projectId, agentName, 'input', testReq.query))
                    .set('Authorization', getAuthHeader())
                    .send({ payload: { text: 'Payload' } });
                // Expect skill and finally to be called...
                await checkState(activationId, COMPLETE, ['agent.input', 'skill.input', 'skill.output', 'skill.input', 'skill.output', 'agent.output'], testReq.query);
                if ( testReq?.data?.query?.sync) {
                    chai.expect(response).to.not.be.empty('No response');
                }
                const state = await checkState(activationId, COMPLETE, ['agent.input', 'skill.input', 'skill.output', 'skill.input', 'skill.output', 'agent.output'], testReq.query);
                const text = state?.response?.text;
                chai.expect(text)
                    .to
                    .have
                    .string('finally:');
            });
            it(`daemons failure with catch + finally ${testReq.name}`, async () => {
                nock('http://cogscale-nock-skill-nock-good.cortex.svc.cluster.local:8080')
                    .matchHeader('Content-type', 'application/json')
                    .post('/finally')
                    .reply(200, (uri, body) => ({ payload: { text: `finally: ${JSON.stringify(body)}` } }));
                nock('http://cogscale-nock-skill-nock-good.cortex.svc.cluster.local:8080')
                    .matchHeader('Content-type', 'application/json')
                    .post('/catch')
                    .reply(200, (uri, body) => ({ payload: { text: `catch: ${JSON.stringify(body)}` } }));
                const agentName = 'cortex/busyboxagent-catchfinally';
                const { req } = mocks.createMocks({
                    params: {
                        agentName,
                        projectId,
                        serviceName: 'input',
                    },
                    query: testReq.query,
                    body: { payload: { text: 'Payload' } },
                });
                req.jwt = JWT;
                req.username = TESTUSER;
                const { activationId, response } = await agentCtrl.invokeAgent(req);
                if ( testReq?.data?.query?.sync) {
                    chai.expect(response).to.not.be.empty('No response');
                }
                const state = await checkState(activationId, ERROR, undefined, testReq.query);
                const text = state?.response?.text;
                chai.expect(text)
                    .to
                    .have
                    .string('catch:')
                    .to
                    .have
                    .string('finally:')
                    .to
                    .have
                    .string('failSkill');
                // eslint-disable-next-line no-unused-expressions
                chai.expect(nock.pendingMocks()).to.be.empty;
            });
            // if I am successful but the "finally" skill fails should NOT call "finally" twice.
            it(`daemons pass with catch + finally 5xx ${testReq.name}`, async () => {
                nock('http://cogscale-nock-skill-nock-good.cortex.svc.cluster.local:8080')
                    .matchHeader('Content-type', 'application/json')
                    .post('/finally')
                    .reply(500, (uri, body) => ({ payload: { text: `finally: ${JSON.stringify(body)}` } }));
                const agentName = 'branch-catchfinally';
                const { req } = mocks.createMocks({
                    params: {
                        agentName,
                        projectId,
                        serviceName: 'input',
                    },
                    query: testReq.query,
                    body: { payload: { text: 'Payload' } },
                });
                req.jwt = JWT;
                req.username = TESTUSER;
                const { activationId, response } = await agentCtrl.invokeAgent(req);
                if ( testReq?.data?.query?.sync) {
                    chai.expect(response).to.not.be.empty('No response');
                }

                const state = await checkState(activationId, ERROR, undefined, testReq.query);
                chai.expect(state.transits)
                    .to
                    .have
                    .length(5);
                chai.expect(state.transits.find((t) => t.from === 'finally'))
                    .to
                    .haveOwnProperty('status')
                    .equal(ERROR);
                const text = state?.response;
                chai.expect(text)
                    .to
                    .have
                    .string('Finally invoke error:');
                // eslint-disable-next-line no-unused-expressions
                chai.expect(nock.pendingMocks()).to.be.empty;
            });
            it(`daemons with catch 5xx skip finally ${testReq.name}`, async () => {
                nock('http://cogscale-nock-skill-nock-good.cortex.svc.cluster.local:8080')
                    .matchHeader('Content-type', 'application/json')
                    .post('/catch')
                    .reply(500, 'BOOM Catch failed');
                const agentName = 'cortex/busyboxagent-catchfinally';
                const { req } = mocks.createMocks({
                    params: {
                        agentName,
                        projectId,
                        serviceName: 'input',
                    },
                    query: testReq.query,
                    body: { payload: { text: 'Payload' } },
                });
                req.jwt = JWT;
                req.username = TESTUSER;
                const { activationId, response } = await agentCtrl.invokeAgent(req);
                const state = await checkState(activationId, ERROR, undefined, testReq.query);
                if ( testReq?.data?.query?.sync) {
                    chai.expect(response).to.not.be.empty('No response');
                }

                const text = state?.response;
                chai.expect(text)
                    .to
                    .have
                    .string('BOOM Catch failed');
                // eslint-disable-next-line no-unused-expressions
                // chai.expect(nock.pendingMocks()).to.be.empty;
                // Do NOT expect finally to be called if catch errors out ..
            });
            it(`agent invoke error throws 500 sync ${testReq.name}`, async () => {
                nock('http://cogscale-nock-skill-nock-good.cortex.svc.cluster.local:8080')
                    .matchHeader('Content-type', 'application/json')
                    .post('/catch')
                    .reply(500, 'BOOM Catch failed');
                const agentName = 'cortex/busyboxagent-catchfinally';

                const { _body: { activationId }, statusCode } = await supertest
                    .post(agentInvokeUrl(projectId, agentName, 'input', testReq.query))
                    .set('Authorization', getAuthHeader())
                    .send({ payload: { text: 'Payload' } });

                if (testReq.query.sync === true) {
                    chai.expect(statusCode).to.equal(500);
                }
                const state = await checkState(activationId, ERROR, undefined, testReq.query);
                const text = state?.response;
                chai.expect(text)
                    .to
                    .have
                    .string('BOOM Catch failed');
                // eslint-disable-next-line no-unused-expressions
                // chai.expect(nock.pendingMocks()).to.be.empty;
                // Do NOT expect finally to be called if catch errors out ..
            });

            it(`daemons failed with catch + finally 5xx ${testReq.name}`, async () => {
                nock('http://cogscale-nock-skill-nock-good.cortex.svc.cluster.local:8080')
                    .matchHeader('Content-type', 'application/json')
                    .post('/finally')
                    .reply(500, 'BOOM finally failed');
                nock('http://cogscale-nock-skill-nock-good.cortex.svc.cluster.local:8080')
                    .matchHeader('Content-type', 'application/json')
                    .post('/catch')
                    .reply(200, (uri, body) => ({ payload: { text: `catch: ${JSON.stringify(body.payload)}` } }));
                const agentName = 'cortex/busyboxagent-catchfinally';
                const { _body: { activationId }, statusCode } = await supertest
                    .post(agentInvokeUrl(projectId, agentName, 'input', testReq.query))
                    .set('Authorization', getAuthHeader())
                    .send({ payload: { text: 'Payload' } });
                if (testReq.query.sync === true) {
                    chai.expect(statusCode).to.equal(500);
                }

                const state = await checkState(activationId, ERROR, undefined, testReq.query);
                chai.expect(state.response)
                    .to
                    .contain('BOOM finally failed');
                // eslint-disable-next-line no-unused-expressions
                chai.expect(nock.pendingMocks()).to.be.empty;
            });
            it(`single daemon with catch only ${testReq.name}`, async () => {
                const agentName = 'cortex/busyboxagent-catchonly';
                const { _body: { activationId, response } } = await supertest
                    .post(agentInvokeUrl(projectId, agentName, 'input', testReq.query))
                    .set('Authorization', getAuthHeader())
                    .send({ payload: { text: 'Payload' } });
                if ( testReq?.data?.query?.sync) {
                    chai.expect(response).to.not.be.empty('No response');
                }
                const state = await checkState(activationId, ERROR, undefined, testReq.query);
                const text = state?.response?.text;
                chai.expect(text)
                    .to
                    .have
                    .string('catch:')
                    .to
                    .not
                    .have
                    .string('finally:');
            });
            it(`branch daemon ${testReq.name}`, async () => {
                const agentName = 'branching';
                const { req } = mocks.createMocks({
                    params: {
                        agentName,
                        projectId,
                        serviceName: 'input',
                    },
                    query: testReq.query,
                    body: { payload: { text: 'Payload' } },
                });
                req.jwt = JWT;
                req.username = TESTUSER;
                const { activationId, response } = await agentCtrl.invokeAgent(req);
                if ( testReq?.data?.query?.sync) {
                    chai.expect(response).to.not.be.empty('No response');
                }
                // input 2x skills + output  = 6
                await checkState(activationId, COMPLETE, [
                    'agent.input',
                    'skill.input', 'skill.output',
                    // 'skill.input', 'skill.output',
                    // 'skill.input', 'skill.output',
                    'skill.input', 'skill.output',
                    'agent.output',
                ], testReq.query);
            });
            it(`multiple inputs mix daemon/jobs service b ${testReq.name}`, async () => {
                // Service B just has a single daemon
                const agentName = 'multiple-input-sync';
                const { req } = mocks.createMocks({
                    params: {
                        agentName,
                        projectId,
                        serviceName: 'b',
                    },
                    query: testReq.query,
                    body: { payload: { text: 'Payload' } },
                });
                req.jwt = JWT;
                req.username = TESTUSER;
                const { activationId, response } = await agentCtrl.invokeAgent(req);
                if ( testReq?.data?.query?.sync) {
                    chai.expect(response).to.not.be.empty('No response');
                }
                // input 2x skills + output  = 6
                await checkState(activationId, COMPLETE, [
                    'agent.input',
                    'skill.input', 'skill.output',
                    'agent.output',
                ], testReq.query);
            });
            it(`lollipop agent single ${testReq.name}`, async () => {
                const agentName = 'lollipop-agent-single';
                const { req } = mocks.createMocks({
                    params: {
                        agentName,
                        projectId,
                        serviceName: 'input',
                    },
                    query: testReq.query,
                    body: { payload: { message: 'Payload' } },
                });
                req.jwt = JWT;
                req.username = TESTUSER;
                const { activationId, response } = await agentCtrl.invokeAgent(req);
                if ( testReq?.data?.query?.sync) {
                    chai.expect(response).to.not.be.empty('No response');
                }
                const state = await checkState(activationId, COMPLETE, [
                    'agent.input',
                    'skill.input',
                    'skill.output',
                    'skill.input',
                    'skill.output',
                    'skill.input',
                    'skill.output',
                    'skill.input',
                    'skill.output',
                    'skill.input',
                    'skill.output',
                    'agent.output',
                ], testReq.query);
                const resp = state?.response?.message;
                // eslint-disable-next-line no-unused-expressions
                chai.expect(resp.startsWith('ECHO: Last ECHO:')).to.be.true;
            });
            it(`lollipop agent merge ${testReq.name}`, async () => {
                const agentName = 'lollipop-agent-merge';
                const { req } = mocks.createMocks({
                    params: {
                        agentName,
                        projectId,
                        serviceName: 'input',
                    },
                    query: testReq.query,
                    body: { payload: { message: 'Payload' } },
                });
                req.jwt = JWT;
                req.username = TESTUSER;
                const { activationId } = await agentCtrl.invokeAgent(req);
                const state = await checkState(activationId, COMPLETE, [
                    'agent.input',
                    'skill.input',
                    'skill.output',
                    'skill.input',
                    'skill.output',
                    'skill.input',
                    'skill.output',
                    'skill.input',
                    'skill.output',
                    'skill.input',
                    'skill.output',
                    'agent.output',
                ], testReq.query);
                const resp = state?.response;
                chai.expect(resp)
                    .to
                    .have
                    .length(2);
            });
            it(`ERROR missing secret ${testReq.name}`, async () => {
                const agentName = 'missing-secret';
                nock('http://localhost:8888')
                    .get(/\/internal\/projects\/cogscale\/secrets.*$/)
                    //            .reply(404, { success: false, message: 'No secret for you' });
                    .reply(200, []); // Calling secrets list api this returns 200 + [] instead of 404..
                const { _body: { activationId }, statusCode } = await supertest
                    .post(agentInvokeUrl(projectId, agentName, 'input', testReq.query))
                    .set('Authorization', getAuthHeader())
                    .send({ payload: { text: 'Payload' } });
                if (testReq.query.sync === true) {
                    chai.expect(statusCode).to.equal(500);
                }
                await checkState(activationId, ERROR, undefined, testReq.query);
            });
            it(`test outputname not output ${testReq.name}`, async () => {
                const agentName = 'diffname';
                const { req } = mocks.createMocks({
                    params: {
                        agentName,
                        projectId,
                        serviceName: 'mesgin',
                    },
                    query: testReq.query,
                    body: { payload: { text: 'Payload' } },
                });
                req.jwt = JWT;
                req.username = TESTUSER;
                const { activationId } = await agentCtrl.invokeAgent(req);
                await checkState(activationId, COMPLETE, ['agent.input', 'skill.input', 'skill.output', 'agent.output'], testReq.query);
            });
            it(`daemon chaining with skill invoke throwing an Error ${testReq.query}`, async () => {
                const agentName = 'cortex%2Fbusyboxagent';
                const { _body: { activationId }, statusCode } = await supertest
                    .post(agentInvokeUrl(projectId, agentName, 'input', testReq.query))
                    .set('Authorization', getAuthHeader())
                    .send({ payload: {
                            text: 'Payload',
                            exception: 'My exception',
                        } });
                if (testReq.query.sync === true) {
                    chai.expect(statusCode).to.equal(500);
                }
                await checkState(activationId, ERROR, undefined, testReq.query);
            });
            // TODO I have one toplevel skill that returns ignore ? should I finish this one or stop execution..
            it(`branch with no-op ${testReq.name}`, async () => {
                // this is a bad test case, but it is possible to build this.
                const agentName = 'no-op-branch';
                const { req } = mocks.createMocks({
                    params: {
                        agentName,
                        projectId,
                        serviceName: 'input',
                    },
                    query: testReq.query,
                    body: { payload: { text: 'Payload' } },
                });
                req.jwt = JWT;
                req.username = TESTUSER;
                const { activationId } = await agentCtrl.invokeAgent(req);
                await checkState(activationId, PENDING, [], testReq.query);
                // This is a dumb test as it won't finish...
                // ATM this is the expected behavior... the system would have to mark as ERROR/COMPLETE later..
            });
            it(`restapi chaining ${testReq.name}`, async () => {
                const { req } = mocks.createMocks({
                    params: {
                        agentName: 'cortex/expapi-agent',
                        projectId,
                        serviceName: 'input',
                    },
                    query: testReq.query,
                    body: { payload: { text: 'Payload' } },
                });
                const body = { payload: 'nock called' };
                req.jwt = JWT;
                req.username = TESTUSER;
                nock('http://httpbin.org')
                    .post('/post')
                    .reply(200, body);
                const { activationId } = await agentCtrl.invokeAgent(req);
                await checkState(activationId, COMPLETE, ['agent.input', 'skill.input', 'skill.output', 'agent.output'], testReq.query);
            });
            it(`missing agent ${testReq.name}`, async () => {
                const { req } = mocks.createMocks({
                    params: {
                        agentName: 'cortex%2Fmissingagent',
                        projectId,
                        serviceName: 'input',
                    },
                    query: testReq.query,
                    body: { payload: { text: 'Payload' } },
                });
                req.jwt = JWT;
                req.username = TESTUSER;

                try {
                    await agentCtrl.invokeAgent(req);
                    Assert.fail();
                } catch (err) {
                    chai.expect(err)
                        .to
                        .haveOwnProperty('output')
                        .haveOwnProperty('statusCode')
                        .equal(404);
                    chai.expect(err.message)
                        .contain('not found');
                }
            });
            it(`agent missing skill ${testReq.name}`, async () => {
                const { req } = mocks.createMocks({
                    params: {
                        agentName: 'cortex/missingskill',
                        projectId,
                        serviceName: 'input',
                    },
                    query: testReq.query,
                    body: { payload: { text: 'Payload' } },
                });
                req.jwt = JWT;
                req.username = TESTUSER;
                try {
                    await agentCtrl.invokeAgent(req);
                    Assert.fail();
                } catch (err) {
                    chai.expect(err)
                        .to
                        .haveOwnProperty('output')
                        .haveOwnProperty('statusCode')
                        .equal(400);
                    chai.expect(err.message)
                        .contain('Unable to find skill');
                }
            });
            it(`missing action ${testReq.name}`, async () => {
                const { req } = mocks.createMocks({
                    params: {
                        agentName: 'cortex/missingaction',
                        projectId,
                        serviceName: 'input',
                    },
                    query: testReq.query,
                    body: { payload: { text: 'Payload' } },
                });
                req.jwt = JWT;
                req.username = TESTUSER;
                try {
                    await agentCtrl.invokeAgent(req);
                    Assert.fail();
                } catch (err) {
                    chai.expect(err)
                        .to
                        .haveOwnProperty('output')
                        .haveOwnProperty('statusCode')
                        .equal(400);
                }
            });
            it(`daemon chaining no namespace ${testReq.name}`, async () => {
                const agentName = 'busyboxagent';
                const { req } = mocks.createMocks({
                    params: {
                        agentName,
                        projectId,
                        serviceName: 'input',
                    },
                    query: testReq.query,
                    body: { payload: { text: 'Payload' } },
                });
                req.jwt = JWT;
                req.username = TESTUSER;
                const { activationId } = await agentCtrl.invokeAgent(req);
                await checkState(activationId, COMPLETE, ['agent.input', 'skill.input', 'skill.output', 'skill.input', 'skill.output', 'agent.output'], testReq.query);
            });
            it(`agent invoke callback ${testReq.name}`, async () => {
                const agentName = 'busyboxagent';
                nock('http://callmeback')
                    .post(/\/.*$/)
                    .reply(200, 'DONE');
                const { req } = mocks.createMocks({
                    params: {
                        agentName,
                        projectId,
                        serviceName: 'input',
                    },
                    body: {
                        properties: {
                            callbackUrl: 'http://callmeback',
                            correlationId: 'calling-activationId',
                        },
                        query: testReq.query,
                        payload: { text: 'Payload' },
                    },
                });
                req.jwt = JWT;
                req.username = TESTUSER;
                const { activationId } = await agentCtrl.invokeAgent(req);
                await checkState(activationId, COMPLETE, undefined, testReq.query); // ['agent.input', 'skill.input', 'skill.output', 'skill.input', 'skill.output', 'agent.output']);
            });
            it(`agent invoke callback failure ${testReq.name}`, async () => {
                const agentName = 'busyboxagent';
                nock('http://callmeback')
                    .post(/\/.*$/)
                    .reply(500, 'BOOM');
                const { req } = mocks.createMocks({
                    params: {
                        agentName,
                        projectId,
                        serviceName: 'input',
                    },
                    query: testReq.query,
                    body: {
                        properties: {
                            callbackUrl: 'http://callmeback',
                            correlationId: 'calling-activationId',
                        },
                        payload: { text: 'Payload' },
                    },
                });
                req.jwt = JWT;
                req.username = TESTUSER;
                const { activationId } = await agentCtrl.invokeAgent(req);
                await checkState(activationId, COMPLETE, undefined, testReq.query); // ['agent.input', 'skill.input', 'skill.output', 'skill.input', 'skill.output', 'agent.output']);
            });
            it(`merge skill ${testReq.query}`, async () => {
                const agentName = 'agentMerge-middle';
                const { req } = mocks.createMocks({
                    params: {
                        agentName,
                        projectId,
                        serviceName: 'input',
                    },
                    query: testReq.query,
                    body: { payload: { text: 'Payload' } },
                });
                req.jwt = JWT;
                req.username = TESTUSER;
                const { activationId } = await agentCtrl.invokeAgent(req);
                const expected = [
                    'agent.input',
                    'skill.input',
                    'skill.input',
                    'skill.output',
                    'skill.output',
                    'skill.input',
                    'skill.input',
                    'skill.output',
                    'skill.output',
                    'skill.input',
                    'skill.output',
                    'agent.output',
                ];
                const { response } = await checkState(activationId, COMPLETE, expected);
                chai.expect(response.params.payload)
                    .to
                    .have
                    .property('results')
                    .length(2);
                // validate agent.input, agent.output once ...
            });
            it(`merge skill compute items ${testReq.name}`, async () => {
                // compute merge items
                const agentName = 'agentMerge-middle-noprops';
                const { req } = mocks.createMocks({
                    params: {
                        agentName,
                        projectId,
                        serviceName: 'input',
                    },
                    query: testReq.query,
                    body: { payload: { text: 'Payload' } },
                });
                req.jwt = JWT;
                req.username = TESTUSER;
                const { activationId } = await agentCtrl.invokeAgent(req);
                const expected = [
                    'agent.input',
                    'skill.input',
                    'skill.input',
                    'skill.output',
                    'skill.output',
                    'skill.input',
                    'skill.input',
                    'skill.output',
                    'skill.output',
                    'skill.input',
                    'skill.output',
                    'agent.output',
                ];
                const { response } = await checkState(activationId, COMPLETE, expected);
                chai.expect(response.params.payload)
                    .to
                    .have
                    .property('results')
                    .length(2);
                // validate agent.input, agent.output once ...
            });
        });
    });
    describe('job agents', () => {
        [
            {
                query: {},
                status: COMPLETE,
            },
            {
                query: { sync: true },
                status: ERROR,
            },
        ].forEach(({ query, status }) => {
            it(`test job invoke ${JSON.stringify(query)}`, async () => {
                const { _body: respBody, statusCode } = await supertest
                    .post(agentInvokeUrl(projectId, 'cortex/hubble_agent', 'input', query))
                    .set('Authorization', getAuthHeader())
                    .send({ payload: { text: 'Job Payload' } });
                if (query.sync === true) {
                    chai.expect(statusCode).to.equal(400);
                    chai.expect(respBody.message)
                        .to
                        .contain('cogscale.cortex/hubble_agent.input cannot be invoked synchronously, these skill(s) are async: cortex/hubblejob');
                } else {
                    // check that activation has gotten created
                    await checkState(respBody?.activationId, PENDING);
                    const channelId = await waitChannelId();
                    // simulate job completion ( operator normally calls this . )
                    const taskReq = mocks.createRequest({
                        headers: { authorization: getAuthHeader() },
                        params: {
                            activationId: respBody?.activationId,
                            channelId,
                        },
                        body: 'TASK DONE>>>',
                    });
                    const taskRes = mocks.createResponse();
                    await taskCtrl.taskCallBack(taskReq, taskRes);
                    await checkState(respBody?.activationId, status, undefined, query);
                }
            });
            it(`test job invoke v2 task api ${JSON.stringify(query)}`, async () => {
                const { _body: { activationId, message }, statusCode } = await supertest
                    .post(agentInvokeUrl(projectId, 'cortex/hubble_agent', 'input', query))
                    .set('Authorization', getAuthHeader())
                    .send({ payload: { text: 'Job Payload' } });
                if (query.sync === true) {
                    chai.expect(statusCode).to.equal(400);
                    chai.expect(message)
                        .to
                        .contain('cogscale.cortex/hubble_agent.input cannot be invoked synchronously, these skill(s) are async: cortex/hubblejob');
                } else {

                    // check that activation has gotten created
                    await checkState(activationId, PENDING);
                    // simulate job completion ( operator normally calls this . )
                    const taskReq = mocks.createRequest({
                        headers: { authorization: getAuthHeader() },
                        body: {
                            payload: 'Task Done>>>',
                            task: {
                                apiVersion: 'fabric.cognitivescale.com/v1',
                                kind: 'Task',
                                metadata: {
                                    creationTimestamp: '2022-06-14T22:54:35Z',
                                    finalizers: [
                                        'cleanup.finalizers.taskpools.fabric.cognitivescale.com',
                                    ],
                                    generateName: 'composetests-gcs-reader-skill-gcs-reader-skill-',
                                    generation: 2,
                                    labels: {
                                        'fabric.actionName': 'hubble-skill',
                                        'fabric.activationId': activationId,
                                        'fabric.channelId': '6697e03c-cca0-4969-bd41-86ce00968455',
                                        'fabric.jobtype': 'invoke',
                                        'fabric.project': 'composetests',
                                        'fabric.serviceName': 'hubble',
                                        'fabric.skillName': 'hubble-skill',
                                        'fabric.source': 'gateway',
                                    },
                                    name: 'hubble-skill-flzqq',
                                    namespace: 'cortex-compute',
                                    resourceVersion: '426987723',
                                    uid: '2e85d1fa-2293-4efd-ad7a-541d079c04f3',
                                },
                                spec: {
                                    actionName: 'hubble',
                                    activationId,
                                    callbackUrl: `http://cortex-processor-gateway.cortex.svc.cluster.local:4444/internal/tasks/${activationId}/output`,
                                    cortexUrl: 'http://cortex-internal.cortex.svc.cluster.local',
                                    // eslint-disable-next-line max-len
                                    payload: `{"activationId":"${activationId}","agentName":"","apiEndpoint":"http://cortex-internal.cortex.svc.cluster.local","channelId":"6697e03c-cca0-4969-bd41-86ce00968455","outputName":"output","payload":{"connection_name":"gcs-test-conn"},"projectId":"composetests","properties":{},"sessionId":"805d2a4a-0620-4f5b-a23b-f57a8663cafd","skillName":"composetests-gcs-reader-skill","timestamp":1655247275970,"token":"eyJraWQiOiJfM1g1aWpvcGdTSm0tSmVmdWJQenh5RS1XWGw3UzJqSVZDLXRNWnNiRG9BIiwiYWxnIjoiRWREU0EifQ.eyJiZWFyZXIiOiJ1c2VyIiwiaWF0IjoxNjU1MjQ3MTg3LCJleHAiOjE2NTUzMzM1ODcsInJvbGVzIjpbImNvcnRleC1hZG1pbnMiXSwic3ViIjoiZ29jZEBleGFtcGxlLmNvbSIsImF1ZCI6ImNvcnRleCIsImlzcyI6ImNvZ25pdGl2ZXNjYWxlLmNvbSJ9.cY6u5_Dk1Z5T7znxGc9Tpty5DYNHlc_Ws7YiyH8_ShA8HIUeSh42mjO90o0yZpJ9uwAsvjSdIgGkLF4p0fsgAw"}`,
                                    resources: {},
                                    skillName: 'hubble-skill',
                                    skillOutputName: 'output',
                                    taskPoolName: 'default',
                                    token: 'TOKEN TOKEN',
                                },
                                status: {
                                    endTime: '2022-06-14T22:54:49Z',
                                    startTime: '2022-06-14T22:54:35Z',
                                    state: 'Completed',
                                },
                            },
                        },
                    });
                    await taskCtrl.storeTask(taskReq);
                    await checkState(activationId, status, undefined, query);
                }
            });
            it(`test job invoke FAILURE with returned state/status ${JSON.stringify(query)}`, async () => {

                const { _body: { activationId, message }, statusCode } = await supertest
                    .post(agentInvokeUrl(projectId, 'cortex/hubble_agent', 'input', query))
                    .set('Authorization', getAuthHeader())
                    .send({ payload: { text: 'Job Payload' } });
                if (query.sync === true) {
                    chai.expect(statusCode)
                        .to
                        .equal(400);
                    chai.expect(message)
                        .to
                        .contain('cogscale.cortex/hubble_agent.input cannot be invoked synchronously, these skill(s) are async: cortex/hubblejob');
                } else {
                    await checkState(activationId, PENDING);
                    const channelId = await waitChannelId();
                    const taskReq = mocks.createRequest({
                        headers: { authorization: getAuthHeader() },
                        params: {
                            activationId,
                            channelId,
                        },
                        query: {
                            state: ERROR,
                        },
                        body: 'TASK DONE>>>',
                    });
                    await taskCtrl.taskCallBack(taskReq);
                    //                const stateFinal = checkAgentInvokeResponse(res);
                    await checkState(activationId, ERROR);
                }
            });
            it(`test agent invoking agent  ${JSON.stringify(query)}`, async () => {
                const agentName = 'agentinvoke';
                nock('http://localhost:4444')
                    .post(/internal\/tasks\/.*/)
                    .reply(200, genJobCallBack(COMPLETE));

                const { _body: { activationId, message }, statusCode } = await supertest
                    .post(agentInvokeUrl(projectId, agentName, 'input', query))
                    .set('Authorization', getAuthHeader())
                    .send({ payload: { text: 'My payload' } });
                if (query.sync === true) {
                    chai.expect(statusCode)
                        .to
                        .equal(400);
                    chai.expect(message)
                        .to
                        .contain('cogscale.agentinvoke.input cannot be invoked synchronously, these skill(s) are async: agent-invoke');
                } else {
                    await checkState(activationId, COMPLETE);
                }
            });

            it(`test agent invoking agent with ERROR ${JSON.stringify(query)}`, async () => {
                // listen for call back
                const agentName = 'agentinvoke';
                // Emulate a failed agent callback .
                nock('http://localhost:4444')
                    .post(/internal\/tasks\/.*/)
                    .reply(200, genJobCallBack('ERROR', true));

                const { _body: { activationId, message }, statusCode } = await supertest
                    .post(agentInvokeUrl(projectId, agentName, 'input', query))
                    .set('Authorization', getAuthHeader())
                    .send({ payload: { text: 'My payload' } });
                if (query.sync === true) {
                    chai.expect(statusCode)
                        .to
                        .equal(400);
                    chai.expect(message)
                        .to
                        .contain('cannot be invoked synchronously');
                } else {
                    await checkState(activationId, ERROR);
                }
            });
            it(`test agent invoking agent with missing agent  ${JSON.stringify(query)}`, async () => {
                // listen for call back
                const agentName = 'agentinvokemissing';
                nock('http://localhost:4444')
                    .post(/internal\/tasks\/.*/)
                    .reply(200, genJobCallBack('ERROR', true));

                const { _body: { activationId, message }, statusCode } = await supertest
                    .post(agentInvokeUrl(projectId, agentName, 'input', query))
                    .set('Authorization', getAuthHeader())
                    .send({ payload: { text: 'My payload' } });
                if (query.sync === true) {
                    chai.expect(statusCode)
                        .to
                        .equal(400);
                    chai.expect(message)
                        .to
                        .contain('cannot be invoked synchronously');
                } else {
                    await checkState(activationId, ERROR, undefined, query);
                }
            });
            it(`multiple inputs mix daemon/jobs service a ${JSON.stringify(query)}`, async () => {
                // run service A with job
                const agentName = 'multiple-input-sync';

                const { _body: { activationId, message }, statusCode } = await supertest
                    .post(agentInvokeUrl(projectId, agentName, 'a', query))
                    .set('Authorization', getAuthHeader())
                    .send({ payload: { text: 'Payload' } });
                if (query.sync === true) {
                    chai.expect(statusCode)
                        .to
                        .equal(400);
                    chai.expect(message)
                        .to
                        .contain('cogscale.multiple-input-sync.a cannot be invoked synchronously, these skill(s) are async: cortex/hubblejob');
                } else {
                    await checkState(activationId, PENDING);
                    // simulate job completion ( operator normally calls this . )
                    const taskReq = mocks.createRequest({
                        headers: { authorization: getAuthHeader() },
                        body: {
                            payload: 'Task Done>>>',
                            task: {
                                apiVersion: 'fabric.cognitivescale.com/v1',
                                kind: 'Task',
                                metadata: {
                                    creationTimestamp: '2022-06-14T22:54:35Z',
                                    finalizers: [
                                        'cleanup.finalizers.taskpools.fabric.cognitivescale.com',
                                    ],
                                    generateName: 'composetests-gcs-reader-skill-gcs-reader-skill-',
                                    generation: 2,
                                    labels: {
                                        'fabric.actionName': 'hubble-skill',
                                        'fabric.activationId': activationId,
                                        'fabric.channelId': 'yjob1',
                                        'fabric.jobtype': 'invoke',
                                        'fabric.project': projectId,
                                        'fabric.serviceName': 'hubble',
                                        'fabric.skillName': 'hubble-skill',
                                        'fabric.source': 'gateway',
                                    },
                                    name: 'hubble-skill-flzqq',
                                    namespace: 'cortex-compute',
                                    resourceVersion: '426987723',
                                    uid: '2e85d1fa-2293-4efd-ad7a-541d079c04f3',
                                },
                                spec: {
                                    actionName: 'hubble',
                                    activationId,
                                    callbackUrl: `http://cortex-processor-gateway.cortex.svc.cluster.local:4444/internal/tasks/${activationId}/output`,
                                    cortexUrl: 'http://cortex-internal.cortex.svc.cluster.local',
                                    // eslint-disable-next-line max-len
                                    payload: `{"activationId":"${activationId}","agentName":"","apiEndpoint":"http://cortex-internal.cortex.svc.cluster.local","channelId":"yjob1","outputName":"output","payload":{"connection_name":"gcs-test-conn"},"projectId":"composetests","properties":{},"sessionId":"805d2a4a-0620-4f5b-a23b-f57a8663cafd","skillName":"composetests-gcs-reader-skill","timestamp":1655247275970,"token":"eyJraWQiOiJfM1g1aWpvcGdTSm0tSmVmdWJQenh5RS1XWGw3UzJqSVZDLXRNWnNiRG9BIiwiYWxnIjoiRWREU0EifQ.eyJiZWFyZXIiOiJ1c2VyIiwiaWF0IjoxNjU1MjQ3MTg3LCJleHAiOjE2NTUzMzM1ODcsInJvbGVzIjpbImNvcnRleC1hZG1pbnMiXSwic3ViIjoiZ29jZEBleGFtcGxlLmNvbSIsImF1ZCI6ImNvcnRleCIsImlzcyI6ImNvZ25pdGl2ZXNjYWxlLmNvbSJ9.cY6u5_Dk1Z5T7znxGc9Tpty5DYNHlc_Ws7YiyH8_ShA8HIUeSh42mjO90o0yZpJ9uwAsvjSdIgGkLF4p0fsgAw"}`,
                                    resources: {},
                                    skillName: 'hubble-skill',
                                    skillOutputName: 'output',
                                    taskPoolName: 'default',
                                    token: 'TOKEN TOKEN',
                                },
                                status: {
                                    endTime: '2022-06-14T22:54:49Z',
                                    startTime: '2022-06-14T22:54:35Z',
                                    state: 'Completed',
                                },
                            },
                        },
                    });
                    await taskCtrl.storeTask(taskReq);
                    await checkState(activationId, COMPLETE, [
                        'agent.input',
                        'skill.input', 'skill.output',
                        'skill.input', 'skill.output',
                        'skill.input', 'skill.output',
                        'agent.output',
                    ], query);
                }
            });
            it(`agent with job multiple messages  ${JSON.stringify(query)}`, async () => {
                const agentName = 'job-message';
                nock('http://localhost:8888')
                    .post(/internal\/messages\/.*/)
                    .times(4)
                    // eslint-disable-next-line func-names
                    .reply(200, function (uri, requestBody, cb) {
                    // Need this to parse the path ( emulating express ... )
                    const pathSegs = _.split(this.req.options.pathname, '/');
                    const { req, res } = mocks.createMocks({
                        params: {
                            activationId: pathSegs[3],
                            channelId: pathSegs[4],
                            outputName: pathSegs[5],
                        },
                        query,
                        headers: this.req.headers,
                        body: requestBody,
                    });
                    req.jwt = JWT;
                    req.username = TESTUSER;
                    taskCtrl.handleMessage(req, res);
                    cb(null, [200, 'NOCK DONE']);
                });
                const { req } = mocks.createMocks({
                    params: {
                        agentName,
                        projectId,
                        serviceName: 'input',
                    },
                    // query: { sync: true },
                    body: {
                        payload: {
                            data: [{
                                    name: 'one',
                                    value: 10,
                                }, {
                                    name: 'two',
                                    value: 20,
                                }, {
                                    name: 'three',
                                    value: 30,
                                }, {
                                    name: 'four',
                                    value: 40,
                                }],
                        },
                    },
                });
                req.jwt = JWT;
                const { activationId } = await agentCtrl.invokeAgent(req);
                // simulate operator call job callback
                // This is a bit artificial, but I don't want the task to "finish" before I finish sending messages ...
                await waitUntil(async () => {
                    const { done } = await synapse.statestore.getJobMessageStats(activationId, 'message-job');
                    return done === 4;
                }, { intervalMs: 10 });
                const taskReq = mocks.createRequest({
                    headers: { authorization: getAuthHeader() },
                    params: {
                        activationId,
                        channelId: 'message-job',
                    },
                    query,
                    body: 'TASK DONE>>>',
                });
                await taskCtrl.taskCallBack(taskReq);
                //checkResponse(taskRes);
                // Expect only 1 agent.output event
                const state = await checkState(activationId, COMPLETE);
                chai.expect(state.response)
                    .to
                    .include({
                    received: 4,
                    done: 4,
                    errors: 0,
                });
                const skill1calls = state.transits.filter((t) => t.from === 'skill1');
                // Should only have 4 calls to skill1
                chai.expect(skill1calls)
                    .to
                    .have
                    .length(4);
            });
            // TODO add sendMessages with an error test case
        });
    });
    describe('skill invoke', () => {
        // Validate invalid sync query param..
        it('Error skill bad sync value', async () => {
            const skillName = 'good-skill';
            const inputName = 'input';
            const body = {
                payload: { text: 'Job Payload' },
                properties: { some: 'prop' },
            };
            const badQuery = { sync: 'BOOOM' };
            const {
                statusCode,
            } = await supertest
                .post(skillInvokeUrl(projectId, skillName, inputName, badQuery))
                .set('Authorization', getAuthHeader())
                .send(body);
            chai.expect(statusCode)
                .to
                .equal(400);
        });

        [
            {
                query: {},
                status: COMPLETE,
            },
            {
                query: { sync: true },
                status: ERROR,
            },
        ].forEach(({
                       query,
                       status,
                   }) => {
            // Basic test invoking a daemon, the daemon is an internal test harness...
            it(`test daemon skill invoke (test action) ${JSON.stringify(query)}`, async () => {
                const skillName = 'good-skill';
                const inputName = 'input';
                const body = {
                        payload: { text: 'Job Payload' },
                        properties: {
                            'daemon.path': 'otherPath',
                            random: 'property',
                        },
                };
                const { _body: resp } = await request(server.app).post(skillInvokeUrl(projectId, skillName, inputName, query))
                    .set('Authorization', getAuthHeader())
                    .send(body);
                const { activationId, response: syncResp } = resp;

                if ( query?.sync ) {
                    chai.expect(syncResp).to.not.be.empty;
                }
                const { response } = await checkState(activationId, COMPLETE, undefined, query);
                chai.expect(response?.params?.properties?.['daemon.path'])
                    .to
                    .equal('otherPath');
                // Don't expect `random` property to be sent to the skill..
                // eslint-disable-next-line no-unused-expressions
                chai.expect(response?.params?.properties?.random).to.be.undefined;
            });

            it(`test mustache skill invoke  ${JSON.stringify(query)}`, async () => {
                const dynamicPath = 'somepath';
                const profileId = '135689';
                nock('http://cogscale-mustache-template-daemongood.cortex.svc.cluster.local:8888')
                   // .matchHeader('Content-type', 'application/json')
                    .get(`/${dynamicPath}/${profileId}`)
                    .reply(200, { payload: { profileId, message: 'GOTHERE' } });

                const skillName = 'mustache-template';
                const inputName = 'mesgin';
                const body = {
                        payload: { text: 'Job Payload', profileId },
                        properties: {
                            dynamicPath,
                        },
                    };
                const { _body: respBody } = await supertest
                    .post(skillInvokeUrl(projectId, skillName, inputName, query))
                    .set('Authorization', getAuthHeader())
                    .send(body)
                    .expect(200);

                const { activationId, response: syncResp } = respBody;

                if ( query?.sync ) {
                    chai.expect(syncResp).to.not.be.empty;
                }

                const { response } = await checkState(activationId, COMPLETE, undefined, query);
                chai.expect(response).to.haveOwnProperty('profileId').equal(profileId);
            });

            it(`test mustache skill invoke, missing keys ${JSON.stringify(query)}`, async () => {
                const dynamicPath = 'somepath';
                const profileId = '135689';
                const dNock = nock('http://cogscale-mustache-template-daemongood.cortex.svc.cluster.local:8888')
                    // .matchHeader('Content-type', 'application/json')
                    .get(`/${dynamicPath}/${profileId}`)
                    .reply(200, { payload: { profileId, message: 'GOTHERE' } });

                const skillName = 'mustache-template';
                const inputName = 'mesgin';
                const body = {
                    payload: { text: 'Job Payload' },
                    properties: {},
                };
                const {  _body: { activationId }, statusCode } = await supertest
                    .post(skillInvokeUrl(projectId, skillName, inputName, query))
                    .set('Authorization', getAuthHeader())
                    .send(body);
                if (query.sync === true) chai.expect(statusCode).to.be.equal(500);  // sync will throw exception ..
                const state = await checkState(activationId, ERROR, undefined, query);
                chai.expect(state.response)
                    .to
                    .contain('missing keys:');
                chai.expect(dNock.pendingMocks()).to.have.length(1);  // Shouldn't have called the daemon.
            });

            // Validate behavior of a 503 daemon response, expect an error to be daemon k8s status
            it(`test skill invoke error (503) ${JSON.stringify(query)}`, async () => {
                nock('http://cogscale-nock-skill-nock-good.cortex.svc.cluster.local:8080')
                    .matchHeader('Content-type', 'application/json')
                    .post('/myapi')
                    .reply(503, 'DOH');
                const skillName = 'nock-skill';
                const inputName = 'input';
                const body = { payload: { text: 'nope' } };
                const { _body: { activationId }, statusCode } = await supertest
                    .post(skillInvokeUrl(projectId, skillName, inputName, query))
                    .set('Authorization', getAuthHeader())
                    .send(body);
                    if (query.sync === true) chai.expect(statusCode).to.equal(500);
                    await checkState(activationId, ERROR, undefined, query);
            });
            // Validate behavior of a 404 daemon response, expect an error to be daemon k8s status
            it(`test skill invoke error (404) ${JSON.stringify(query)}`, async () => {
                nock('http://cogscale-nock-skill-nock-good.cortex.svc.cluster.local:8080')
                    .matchHeader('Content-type', 'application/json')
                    .post('/myapi')
                    .reply(404, '404 - NOT found');
                 const skillName = 'nock-skill';
                 const inputName = 'input';
                 const body = { payload: { text: 'nope' } };

                const { _body: respBody, statusCode } = await supertest
                    .post(skillInvokeUrl(projectId, skillName, inputName, query))
                    .set('Authorization', getAuthHeader())
                    .send(body);
                const { activationId } = respBody;
                if (query.sync === true) {
                    chai.expect(statusCode).to.be.equal(500);
                } else {
                    // expect activationId response
                    chai.expect(statusCode).to.be.equal(200);
                }
                await checkState(activationId, ERROR, undefined, query);
            });

            // Validate error behavior 500, expect http response body in error message..
            it(`test nock skill (500) ${JSON.stringify(query)}`, async () => {
                const daemonText = 'Some code error 500';
                nock('http://cogscale-nock-skill-nock-good.cortex.svc.cluster.local:8080')
                    .matchHeader('Content-type', 'application/json')
                    .post('/myapi')
                    .reply(500, daemonText);
                const skillName = 'nock-skill';
                const inputName = 'input';
                const body = { payload: { text: 'nope' } };
                const { _body: resBody, statusCode } = await request(server.app).post(skillInvokeUrl(projectId, skillName, inputName, query))
                    .set('Authorization', getAuthHeader())
                    .send(body);
                 if (query.sync === true) {
                     chai.expect(statusCode)
                         .to
                         .equal(500);
                 }
                const state = await checkState(resBody?.activationId, ERROR, undefined, query);
                chai.expect(state)
                    .to
                    .have
                    .property('response')
                    .includes(daemonText);
            });
            // Expect immediate error for invalid skill name
            it(`Skill invoke missing skill ${JSON.stringify(query)}`, async () => {

                const { _body: {  message }, statusCode } = await request(server.app).post(skillInvokeUrl(projectId, 'nothere-skill', 'input', query))
                    .set('Authorization', getAuthHeader())
                    .send({
                        payload: { text: 'Job Payload' },
                        properties: { some: 'prop' },
                    });
                    // Should fail fast and be same result, sync = true|false
                    chai.expect(statusCode)
                        .to
                        .equal(404);
                    chai.expect(message)
                        .to
                        .equal('Skill "nothere-skill" not found in project "cogscale"');
            });

            it(`Skill invoke multiple input daemon ${JSON.stringify(query)}`, async () => {
                // Skill has two inputs daemon & job, call "daemon" should always work...  calling "job" should fail if sync

                const skillName = 'multi-input-daemon-job';
                let inputName = 'daemon';
                const body = {
                    payload: { text: 'Job Payload' },
                    properties: { some: 'prop' },
                };
                const { _body: resp } = await request(server.app).post(skillInvokeUrl(projectId, skillName, inputName, query))
                    .set('Authorization', getAuthHeader())
                    .send(body);
                const { activationId } = resp;
                await checkState(activationId, COMPLETE, undefined, query);

                inputName = 'job';
                const { _body: { activationId: jobActId, message }, statusCode } = await request(server.app).post(skillInvokeUrl(projectId, skillName, inputName, query))
                    .set('Authorization', getAuthHeader())
                    .send(body);
                if (query.sync === true) {
                    chai.expect(statusCode)
                        .to
                        .equal(400);
                    chai.expect(message)
                        .to
                        .contain('cannot be invoked synchronously');
                } else {
                    await checkState(jobActId, PENDING, undefined, query); // expect pending before task callback is called.
                    const channelId = await waitChannelId();
                    const taskReq = mocks.createRequest({
                        headers: { authorization: getAuthHeader() },
                        params: {
                            activationId: jobActId,
                            channelId,
                        },
                        body: 'TASK DONE>>>',
                    });
                    await taskCtrl.taskCallBack(taskReq);
                    await checkState(jobActId, COMPLETE, undefined, query);
                }
                // Should fail fast and be same result, sync = true|false
            });

            it(`test job skill invoke ${JSON.stringify(query)}`, async () => {
                const { _body: {  activationId, message }, statusCode } = await request(server.app).post(skillInvokeUrl(projectId, 'cortex/hubblejob', 'input', query))
                    .set('Authorization', getAuthHeader())
                    .send({
                        payload: { text: 'Job Payload' },
                    });
                if (query.sync === true) {
                    chai.expect(statusCode)
                        .to
                        .equal(400);
                    chai.expect(message)
                        .to
                        .contain('cannot be invoked synchronously');
                } else {
                    await checkState(activationId, PENDING, undefined, query); // expect pending before task callback is called.
                    const channelId = await waitChannelId();
                    const taskReq = mocks.createRequest({
                        headers: { authorization: getAuthHeader() },
                        params: {
                            activationId,
                            channelId,
                        },
                        body: 'TASK DONE>>>',
                    });
                    await taskCtrl.taskCallBack(taskReq);
                    const { response } = await checkState(activationId, status, undefined, query);
                    chai.expect(response)
                        .to
                        .not
                        .equal('Log message...');
                }
            });
            it(`test job skill invoke with send_message() ${JSON.stringify(query)}`, async () => {
                const { _body: { activationId, message }, statusCode } = await request(server.app).post(skillInvokeUrl(projectId, 'cortex/hubblejob', 'input', query))
                    .set('Authorization', getAuthHeader())
                    .send({
                        payload: { text: 'Job Payload' },
                    });
                if (query.sync === true) {
                    chai.expect(statusCode)
                        .to
                        .equal(400);
                    chai.expect(message)
                        .to
                        .contain('cannot be invoked synchronously');
                } else {
                    await checkState(activationId, PENDING); // expect pending before task callback is called.
                    const channelId = await waitChannelId();
                    const sendMsgReq = mocks.createRequest({
                        headers: { authorization: getAuthHeader() },
                        params: {
                            activationId,
                            channelId,
                        },
                        body: {
                            payload: { text: 'sent a message' },
                            outputName: 'foo',
                        },
                    });
                    const sendMsgResp = mocks.createResponse();
                    await taskCtrl.handleMessage(sendMsgReq, sendMsgResp);
                    const taskReq = mocks.createRequest({
                        headers: { authorization: getAuthHeader() },
                        params: {
                            activationId,
                            channelId,
                        },
                        body: 'Log message...',
                    });
                    await taskCtrl.taskCallBack(taskReq);
                    // await waitAgentDone(activationId);
                    const { response } = await checkState(activationId, COMPLETE, undefined, query);
                    chai.expect(response)
                        .to
                        .not
                        .equal('Log message...');
                }
            });
        });
    });
});
