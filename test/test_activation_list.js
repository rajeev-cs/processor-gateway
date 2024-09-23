import _ from 'lodash';
import assert from 'assert';
import config from 'config';
import { getLogger } from '@tt-sensa/sensa-express-common';
import chai from 'chai';
import mongoose from 'mongoose';
import Redis from 'ioredis';
import importFresh from 'import-fresh';
import { MongoStateStore } from '../lib/state/mongoStateStore.js';
import { Synapse } from '../lib/synapse.js';
import { Infra } from '../lib/interfaces/Infra.js';
import { RuntimeProvider } from '../lib/actions/runtimeProvider.ts';
import { getResourceProvider } from '../lib/clients/resources.js';
import { getStateStore } from '../lib/state/stateStore.js';
import { createEventHandler } from '../lib/events/handler.js';

import { AgentController } from '../lib/controllers/agent.controller.js';
import request from 'supertest';
import server from '../lib/server.js';
import { getAuthHeader } from './testutil/index.js';

const supertest = request(server.app);

const { logger } = getLogger('test', config.get('logging'));
describe('mongo construct filter tests', () => {
    const { constructFilter } = { MongoStateStore }.MongoStateStore;
    it('test filter all params', () => {
        const projectId = 'cogscale';
        const agentName = 'default/busybox';
        const query = {
            agentName,
            startAfter: 10,
            startBefore: 100,
            endAfter: 100,
            endBefore: 200,
            status: 'complete', // this will be converted to uppercase
        };
        const expectedFilter = {
            'state.start': {
                $gte: query.startAfter,
                $lt: query.startBefore,
            },
            'state.end': {
                $gte: query.endAfter,
                $lt: query.endBefore,
            },
            'state.status': query.status.toUpperCase(),
            'state.projectId': projectId,
            'state.agentName': agentName,
        };
        const filter = constructFilter(projectId, query);
        chai.expect(filter).to.deep.equal(expectedFilter);
    });
    it('test filter no params', () => {
        const projectId = 'cogscale';
        const agentName = 'default/busybox';
        const query = { agentName };
        const expectedFilter = {
            'state.projectId': projectId,
            'state.agentName': agentName,
        };
        const filter = constructFilter(projectId, query);
        chai.expect(filter).to.deep.equal(expectedFilter);
    });
});
Object.values(['mongo', 'memory']).forEach((storeType) => {
    describe(`activation listing and filtering with stateStore: ${storeType}`, () => {
        let agentCtrl;
        let synapse;
        let stateStore;
        let redisClient;
        // eslint-disable-next-line no-unused-vars
        // let callBackUrl;
        before(async () => {
            try {
                // const override = {
                //     state: {
                //         store: storeType,
                //     },
                // };
                config.state.store = storeType;
                importFresh('config');
                // const newConfig = testutil.copyAndMerge(config, override);
                // testutil.mockConfig(newConfig);
                if (storeType === 'mongo') {
                    await mongoose.connect(config.mongo.uri, config.get('mongo.options'));
                    logger.info('debug', 'Connected to admin database');
                }
                redisClient = new Redis(config.redis.uri);
                const infra = new Infra({ redis: redisClient, logger });
                infra.resourceProvider = await getResourceProvider();
                infra.eventHandler = createEventHandler(infra);
                stateStore = getStateStore(infra, storeType);
                
                const runtimeProvider = new RuntimeProvider(infra);
                synapse = new Synapse(infra, stateStore, runtimeProvider);
                agentCtrl = new AgentController(infra, synapse, undefined);
                const activationList = {
                    complete: {
                        requestId: 'complete-request',
                        agentName: 'cortex/busybox',
                        projectId: 'cogscale',
                        start: 1,
                        status: 'COMPLETE',
                        end: 10,
                    },
                    failed: {
                        requestId: 'failed-request',
                        agentName: 'cortex/busybox',
                        projectId: 'cogscale',
                        start: 2,
                        status: 'FAILED',
                        end: 10,
                    },
                    long: {
                        requestId: 'long-running-request',
                        agentName: 'cortex/busybox',
                        projectId: 'cogscale',
                        start: 100,
                        status: 'COMPLETE',
                        end: 10000,
                    },
                    newProject: {
                        requestId: 'newProject',
                        agentName: 'cortex/busybox',
                        projectId: 'cleetus',
                        start: 1,
                        status: 'COMPLETE',
                        end: 10,
                    },
                    newProjectDiffAgent: {
                        requestId: 'newProjectDiffAgent',
                        agentName: 'new/agent',
                        projectId: 'cleetus',
                        start: 1,
                        status: 'COMPLETE',
                        end: 10,
                    },
                };
                await Promise.all(_.map(activationList, async (a) => stateStore.startActivation(a.requestId, a)));
            } catch (e) {
                console.error(`Error connecting to admin database, shutting down:${e}`);
                process.exit(1);
            }
        });
        after(async () => {
            // testutil.restoreConfig();
            try {
                if (storeType === 'mongo') {
                    await mongoose.connection.db.dropCollection('SynapseState');
                    await mongoose.disconnect();
                }
                await redisClient.disconnect();
            } catch (e) {
                console.error(`Error connecting to admin database, shutting down:${e}`);
                process.exit(1);
            }
        });

        it(`${storeType}: FAB-1312 get activation`, async () => {
            const res = await agentCtrl.getActivation('cleetus', 'newProject');
            chai.expect(res).to.haveOwnProperty('status').equal('COMPLETE');
        });

        it(`${storeType}: get activation bad boolean flag`, async () => {
            try {
                await agentCtrl.getActivation('cleetus', 'newProject', false, '');
                assert.fail();
            } catch (err) {
                chai.expect(err).to.haveOwnProperty('output').haveOwnProperty('statusCode').equal(400);
            }
        });

        it(`${storeType}: return 404 not found`, async () => {
            await supertest
                .get('/fabric/v4/projects/cleetus/activations/NOTHERE')
                .set('Authorization', getAuthHeader())
                .expect(404);
            // Expect cancellation of non-existing activation to return a 404
            await supertest
                .post('/fabric/v4/projects/cleetus/activations/NOTHERE/cancel')
                .set('Authorization', getAuthHeader())
                .expect(404);

        });

        it(`${storeType}: FAB-1312 don't allow getting activations across projects`, async () => {
            try {
                await agentCtrl.getActivation('cogscale', 'newProjectDiffAgent', false, false);
                assert.fail();
            } catch (err) {
                chai.expect(err).to.haveOwnProperty('output').haveOwnProperty('statusCode').equal(404);
            }
        });

        it(`${storeType}: list activation, bad JSON string`, async () => {
            try {
                await agentCtrl.listActivations('cleetus', "{ badkeys: 'xxxxx'");
                assert.fail();
            } catch (err) {
                chai.expect(err).to.haveOwnProperty('output').haveOwnProperty('statusCode').equal(400);
            }
        });

        // We ignore agent name anyway, activationId is sufficiently unique..
        // it(`${storeType}: FAB-1312 get activation in a project regardless of the agent name`, async () => {
        //     const { req, res } = mocks.createMocks({
        //         params: {
        //             name: 'new/agent',
        //             projectId: 'cleetus',
        //             activationId: 'newProject', // this activationId belongs to name: 'cortex/busybox'
        //         },
        //     });
        //     await agentCtrl.getActivation(req, res);
        //     checkResponse(res, 200);
        // });

        it(`${storeType}: list all activations badkey`, async () => {
            try {
                await agentCtrl.listActivations('cleetus', { badkeys: 'xxxxx' });
                assert.fail();
            } catch (err) {
                chai.expect(err).to.haveOwnProperty('output').haveOwnProperty('statusCode').equal(400);
            }
        });

        it(`${storeType}: list all activations bad sort`, async () => {
            try {
                await agentCtrl.listActivations('cleetus', undefined, undefined, undefined, '{start: 1}');
                assert.fail();
            } catch (err) {
                chai.expect(err).to.haveOwnProperty('output').haveOwnProperty('statusCode').equal(400);
            }
        });

        it(`${storeType}: list all activations bad skill and agent query`, async () => {
            try {
                await agentCtrl.listActivations('cleetus', { agentName: 'testerAgent', skillName: 'testerSkill' });
                assert.fail('Should have failed');
            } catch (err) {
                chai.expect(err).to.haveOwnProperty('output').haveOwnProperty('statusCode').equal(400);
            }
        });

        it(`${storeType}: list all activations bad skill and agent query, filter as string`, async () => {
            try {
                await agentCtrl.listActivations('cleetus', JSON.stringify({ agentName: 'testerAgent', skillName: 'testerSkill' }));
                assert.fail('Should have failed');
            } catch (err) {
                chai.expect(err).to.haveOwnProperty('output').haveOwnProperty('statusCode').equal(400);
            }
        });

        it(`${storeType}: list all activations`, async () => {
            const { activations } = await agentCtrl.listActivations('cogscale', {});
            chai.expect(activations.map((a) => a.activationId)).to.have.all.members(['complete-request', 'failed-request', 'long-running-request']);
        });

        if (storeType === 'mongo') {
            it(`${storeType}: list all activations honoring filter param`, async () => {
                const { activations } = await agentCtrl.listActivations('cogscale', { status: 'COMPLETE' });
                chai.expect(activations).to.have.lengthOf(2);
                chai.expect(activations.map((a) => a.status)).to.have.all.members(['COMPLETE', 'COMPLETE']);
            });
            it(`${storeType}: list all activations honoring limit param`, async () => {
                const { activations } = await agentCtrl.listActivations('cogscale', undefined, 2);
                chai.expect(activations).to.have.lengthOf(2);
            });
            it(`${storeType}: list all activations honoring skip param`, async () => {
                const { activations } = await agentCtrl.listActivations('cogscale', undefined, undefined, 2);
                chai.expect(activations).to.have.lengthOf(1);
            });
            it(`${storeType}: list all activations honoring filter sort`, async () => {
                const { activations } = await agentCtrl.listActivations('cogscale', undefined, undefined, undefined, { status: 1 });
                chai.expect(activations.map((a) => a.status)).to.have.all.members(['COMPLETE', 'COMPLETE', 'FAILED']);
            });
            it(`${storeType}: list activations filter sort bad option should throw a bad request error`, async () => {

                    try {
                        await agentCtrl.listActivations('cogscale', undefined, undefined, undefined, 'invalid');
                        assert.fail();
                    } catch (err) {
                        chai.expect(err).to.haveOwnProperty('output').haveOwnProperty('statusCode').equal(400);
                        chai.expect(err.message).to.equal('Invalid query params');
                        chai.expect(err?.data?.details?.[0]?.type).to.equal('sort');

                    }
                });

            it(`${storeType}: list activations filter sort simple ascending`, async () => {
                const { activations } = await agentCtrl.listActivations('cogscale', undefined, undefined, undefined, 'asc');
                chai.expect(activations.map((a) => a.activationId)).to.deep.equal(['complete-request', 'failed-request', 'long-running-request']);
            });

            it(`${storeType}: list activations filter sort simple desc`, async () => {

                const { activations } = await agentCtrl.listActivations('cogscale', undefined, undefined, undefined, 'desc');
                chai.expect(activations.map((a) => a.activationId)).to.deep.equal(['long-running-request', 'failed-request', 'complete-request']);
            });

            xit(`${storeType}: list activations filter sort numerical ascending`, async () => {
                const { activations } = await agentCtrl.listActivations('cogscale', undefined, undefined, undefined, 1);
                chai.expect(activations.map((a) => a.activationId)).to.deep.equal(['complete-request', 'failed-request', 'long-running-request']);
            });
            xit(`${storeType}: list activations filter sort numerical desc`, async () => {
                const { activations } = await agentCtrl.listActivations('cogscale', undefined, undefined, undefined, -1);
                chai.expect(activations.map((a) => a.activationId)).to.deep.equal(['long-running-request', 'failed-request', 'complete-request']);
            });
        }
        it(`${storeType}: list activations by status failed`, async () => {
            const { activations } = await agentCtrl.listActivations('cogscale', { status: 'failed' });
            chai.expect(activations.map((a) => a.activationId)).to.have.all.members(['failed-request']);
        });
        // limit just by start
        it(`${storeType}: list activations limit by startAfter and startBefore`, async () => {
            const { activations } = await agentCtrl.listActivations('cogscale',  {
                startAfter: 2,
                startBefore: 100,
            });
            chai.expect(activations.map((a) => a.activationId)).to.deep.equal(['failed-request']);
        });
        // limit by start.before
        it(`${storeType}: list activations limit just by startBefore`, async () => {
            const { activations } = await agentCtrl.listActivations('cogscale', {
                startBefore: 100,
            });
            chai.expect(activations.map((a) => a.activationId)).to.have.all.members(['complete-request', 'failed-request']);
        });
        // limit by start.after
        it(`${storeType}: list activations limit just by startAfter`, async () => {
            const { activations } = await agentCtrl.listActivations('cogscale', {
                startAfter: 10,
            });
            chai.expect(activations.map((a) => a.activationId)).to.deep.equal(['long-running-request']);
        });
        // l    imit just by end
        it(`${storeType}: list activations limit by endAfter and endBefore`, async () => {
            const { activations } = await agentCtrl.listActivations('cogscale', {
                endAfter: 11,
                endBefore: 10001,
            });
            chai.expect(activations.map((a) => a.activationId)).to.deep.equal(['long-running-request']);
        });
        // limit by end.before
        it(`${storeType}: list activations limit just by endBefore`, async () => {
            const { activations } = await agentCtrl.listActivations('cogscale', {
                endBefore: 100,
            });
            chai.expect(activations.map((a) => a.activationId)).to.have.all.members(['complete-request', 'failed-request']);
        });
        // limit by end.after
        it(`${storeType}: list activations limit just by endAfter`, async () => {
            const { activations } = await agentCtrl.listActivations('cogscale', {
                    endAfter: 11,
            });
            chai.expect(activations.map((a) => a.activationId)).to.have.all.members(['long-running-request']);
        });
        it(`${storeType}: list activations filter only long running`, async () => {
            const { activations } = await agentCtrl.listActivations('cogscale', {
                    startAfter: 4,
                    startBefore: 101,
                    endAfter: 100,
                    endBefore: 10001,
            });
            chai.expect(activations.map((a) => a.activationId)).to.have.all.members(['long-running-request']);
        });
        it(`${storeType}: list activations filter exclude first activation`, async () => {
            const { activations } = await agentCtrl.listActivations('cogscale', {
                startAfter: 2,
                startBefore: 101,
                endAfter: 10,
                endBefore: 10001,
            });
            chai.expect(activations.map((a) => a.activationId)).to.have.all.members(['failed-request', 'long-running-request']);
        });
        Object.values(['startBefore', 'startAfter', 'endBefore', 'endAfter', 'status']).forEach((qp) => {
            it(`${storeType}: list activations ${qp} empty string`, async () => {
                const query = {};
                query[qp] = '';
                const { activations } = await agentCtrl.listActivations('cogscale', query);
                if (_.includes(['startBefore', 'endBefore', 'status'], qp)) {
                    chai.expect(activations.map((a) => a.activationId)).to.have.all.members([]);
                } else {
                    chai.expect(activations.map((a) => a.activationId)).to.have.all.members(['complete-request', 'failed-request', 'long-running-request']);
                }
            });
            it(`${storeType}: list activations ${qp} undefined`, async () => {
                const query = {};
                query[qp] = undefined;
                const { activations } = await agentCtrl.listActivations('cogscale',  query);
                chai.expect(activations.map((a) => a.activationId)).to.have.all.members([]);
            });
        });
    });
});
