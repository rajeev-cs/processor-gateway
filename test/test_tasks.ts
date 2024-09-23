import { Readable } from 'stream';
/* eslint-disable @typescript-eslint/no-unused-expressions */
import _ from 'lodash';
import * as boom from '@hapi/boom';
import * as mocks from 'node-mocks-http';
import chai from 'chai';
import nock from 'nock';
import Assert from 'node:assert';
import config from 'config';
import { getNamespace, K8SClient } from '@tt-sensa/sensa-express-common/k8s.js';
import { glob } from 'glob';
import yaml from 'js-yaml';
import fs from 'node:fs';
import sinon from 'sinon';
import mongoose from 'mongoose';
import Redis from 'ioredis';
import qs from 'qs';
import * as testutil from './testutil/index.js';
import { getResourceProvider } from '../lib/clients/resources.js';
import { RuntimeProvider } from '../lib/actions/runtimeProvider.js';
import { getStateStore } from '../lib/state/stateStore.js';
import { createEventHandler } from '../lib/events/handler.js';
import { TaskController } from '../lib/controllers/task.controller.js';
import { AgentController } from '../lib/controllers/agent.controller.js';
import { InternalController } from '../lib/controllers/internal.controller.js';
import { validateCron } from '../lib/actions/taskUtils.js';
import { Synapse } from '../lib/synapse.js';
import { tpl } from '../lib/clients/k8sResources.js';
import { StateStore } from '../lib/state/abstractStateStore.js';
import Infra from '../lib/interfaces/Infra.js';
import { checkResponse, getAuthHeader } from './testutil/index.js';
import request from 'supertest';
import server from '../lib/server.js';

const testUtil = testutil;
const logger = testUtil.mockLogger(false);
function checkAll(l, check) {
    // eslint-disable-next-line no-unused-expressions
    chai.expect(_.every(l.map((i) => check(i)))).to.be.true;
}
function checkTaskListCommonmEntry(t) {
    chai.expect(t).to.have.property('name').to.be.a('string');
    chai.expect(t).to.have.property('startTime').to.be.a('string');
    chai.expect(t).to.have.property('state').to.be.a('string');
    // Active tasks will not have an endTime
    t.state.toUpperCase() !== 'ACTIVE' && chai.expect(t).to.have.property('endTime').to.be.a('string');
    return true;
}
function checkTaskListEntry(t) {
    checkTaskListCommonmEntry(t);
    chai.expect(t).to.have.property('actionName').to.be.a('string');
    chai.expect(t).to.have.property('skillName').to.be.a('string');
    if (!t.schedule) {
        chai.expect(t)
            .to
            .have
            .property('activationId')
            .to
            .be
            .a('string');
    }
    return true;
}
describe('Task APIs', () => {
    let taskCtrl;
    let agentCtrl;
    let internalCtrl;
    let synapse;
    let k8sClient;
    let redisClient;
    const projectId = 'cogscale';
    // const projectId = 'test';
    const apiVersion = 'fabric.cognitivescale.com/v1';
    const serverUrl = 'http://server.com';
    const kind = 'task';
    const tasks = {};
    const infra = new Infra({ redis: redisClient, logger });
    before(async () => {
        if (!nock.isActive()) {
            nock.activate();
        }
        redisClient = new Redis(config.redis.uri || '', {});
        k8sClient = await K8SClient.newClient();
        const resourceProvider = await getResourceProvider();
        infra.eventHandler = createEventHandler(infra);
        infra.k8sClient = k8sClient;
        infra.resourceProvider = resourceProvider;
        const stateStore: StateStore = getStateStore(infra);
        const runtimeProvider = new RuntimeProvider(infra);
        synapse = new Synapse(infra, stateStore, runtimeProvider);
        await mongoose.connect(config.get('mongo.uri'), config.get('mongo.options'));
        taskCtrl = new TaskController(infra, synapse);
        agentCtrl = new AgentController(infra, synapse, undefined);
        internalCtrl = new InternalController(infra, synapse, taskCtrl.taskCtl);
        const taskFiles = glob.sync(`${config.resources.tasksPath}/*.json`);
        taskFiles.forEach((taskFile) => {
            const task: any = yaml.load(fs.readFileSync(taskFile).toString());
            if (_.isEmpty(task.spec.schedule)) {
                tasks[task.metadata.name] = task;
            }
        });
    });
    after(async () => {
        await redisClient.disconnect();
    });
    afterEach(() => {
        // clean up mocks that may not have been called
        nock.cleanAll();
    });
    const K8S_URLS = {
        resources: (ver, type, namespace, name) => `/apis/${ver}/namespaces/${namespace}/${type}s/${name}`,
        // eslint-disable-next-line max-len
        resourceList: (ver, type, namespace, labelSelectors) => `/apis/${ver}/namespaces/${namespace}/${type}s?pretty=&allowWatchBookmarks=&continue=&fieldSelector=&labelSelector=${encodeURIComponent(labelSelectors.toString())}`,
        pods: (namespace, labelSelectors) => `/api/v1/namespaces/${namespace}/pods?labelSelector=${encodeURIComponent(labelSelectors.toString())}`,
        podLogs: (name, namespace, labelSelectors) => `/api/v1/namespaces/${namespace}/pods/${name}/log?&labelSelector=${encodeURIComponent(labelSelectors.toString())}`,
        podLiveLogs: (name, namespace) => `/api/v1/namespaces/${namespace}/pods/${name}/log?follow=true&timestamps=true`,
    };
    describe('mongo tasks', () => {
        const sandbox = sinon.createSandbox();
        before(async () => {
            taskCtrl.taskCtl.persist = true;
            sandbox.stub(taskCtrl.taskCtl, 'handleTaskCallback').returns({ message: 'sinon was here' });
            await Promise.all(Object.values(tasks).map(async (task) => {
                const { req } = mocks.createMocks({
                    headers: { authorization: getAuthHeader() },
                    body: { task },
                });
                await internalCtrl.storeTask(req);
            }));
        });
        after(() => {
            taskCtrl.taskCtl.persist = false;
            sandbox.restore();
        });

        it('lists tasks in project no filter', async () => {
            const { tasks: tasksResp } = await taskCtrl.listTasks(projectId);
            chai.expect(tasksResp.length).to.equal(3);
            checkAll(tasksResp, checkTaskListCommonmEntry);
        });

        it('lists tasks in project actionName', async () => {
            const { tasks: tasksResp } = await taskCtrl.listTasks(projectId, 'amp-cli');
            chai.expect(tasksResp.length).to.equal(2);
            checkAll(tasksResp, checkTaskListCommonmEntry);
        });

        it('lists tasks in project skillName', async () => {
            const { tasks: tasksResp } = await taskCtrl.listTasks(projectId, undefined, undefined, undefined, 'composetests-success-job-skill');
            checkAll(tasksResp, checkTaskListCommonmEntry);
        });

        it('lists tasks in project and BAD filter', async () => {
            try {
                await taskCtrl.listTasks(projectId, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, '{ start: 1 }');
                Assert.fail('Should fail');
            } catch (err) {
                chai.expect(err).to.haveOwnProperty('output').haveOwnProperty('statusCode').equal(400);
            }
        });

        it('lists tasks in project and BAD sort', async () => {
            try {
                await taskCtrl.listTasks(projectId, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, '{ start : 1}');
                Assert.fail('Should fail');
            } catch (err) {
                chai.expect(err).to.haveOwnProperty('output').haveOwnProperty('statusCode').equal(400);
            }
        });

        it('lists tasks in project agentName and sort', async () => {
            const { tasks: taskResp } = await taskCtrl.listTasks(projectId, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, '{ "startTime" : 1}');
            chai.expect(taskResp.length).to.equal(3);
        });

        it('empty list in a project with no tasks', async () => {
            const { tasks: taskResp } = await taskCtrl.listTasks('invalidProject');
            chai.expect(taskResp.length).to.equal(0);
        });

        it('get status task resource', async () => {
            try {
                await taskCtrl.taskStatus(projectId, 'abc');
                Assert.fail('Should fail');
            } catch (err) {
                chai.expect(err).to.haveOwnProperty('output').haveOwnProperty('statusCode').equal(404);
            }

            const dsRes = await taskCtrl.taskStatus(projectId, 'test1-9292');

            chai.expect(dsRes).to.haveOwnProperty('status').equal('COMPLETED');
            chai.expect(dsRes).to.haveOwnProperty('resourceType').equal('DataSource');
            chai.expect(dsRes).to.haveOwnProperty('resourceName').equal('test1-9292');
            chai.expect(dsRes).to.haveOwnProperty('success').equal(true);
        });

        it('get status agent resource', async () => {
            const res = await agentCtrl.agentStatus(projectId, 'abc');
            chai.expect(res).to.haveOwnProperty('status').equal('Not Found');
            chai.expect(res).to.haveOwnProperty('resourceName').equal('abc');
            chai.expect(res).to.haveOwnProperty('success').equal(true);
        });

        it('echo agent resource', async () => {
            const res = await agentCtrl.echo();
            chai.expect(res).to.haveOwnProperty('message').equal('echo');
            chai.expect(res).to.haveOwnProperty('success').equal(true);
        });


        it('fetches a task', async () => {
            const taskName = 'composetests-success-job-skill-success-job-79ttq';
            const { task } = await taskCtrl.getTask(projectId, taskName);
            // TODO verify response body
            chai.expect(task.name).to.equal(taskName);
        });
        it('fetches a task with k8s option', async () => {
            const taskName = '4da2dd49-9467-40fc-955f-a89df88c5194';
            const { task, k8s } = await taskCtrl.getTask(projectId, taskName, true);
            logger.debug(`body: ${JSON.stringify(task)}`);
            // TODO verify response body
            chai.expect(task.name).to.equal(taskName);
            chai.expect(task.fabricResource).to.equal('test1-9e950');
            chai.expect(task.resourceType).to.equal('ProfileSchema');
            chai.expect(task.jobType).to.equal('build-profile');
            chai.expect(k8s).to.have.nested.property('metadata.name').equal(taskName);
        });
        it('unable to fetch a task in the wrong project', async () => {
            const taskName = 'unique-task';
            // check db then k8s
            nock(serverUrl)
                .get(/.*/)
                .reply(404, {});
            try {
                await taskCtrl.getTask(projectId, taskName, true);
                Assert.fail('Should fail');
            } catch (err) {
                chai.expect(err).to.haveOwnProperty('output').haveOwnProperty('statusCode').equal(404);
            }
        });
        it('404 invalid task name', async () => {
            const taskName = 'invalid-task-name';
            // check db then k8s
            nock(serverUrl)
                .get(/.*/)
                .reply(404, {});
            try {
                await taskCtrl.getTask(projectId, taskName, true);
                Assert.fail('Should fail');
            } catch (err) {
                chai.expect(err).to.haveOwnProperty('output').haveOwnProperty('statusCode').equal(404);
            }
        });
    });
    describe('K8S LIST', () => {
        it('lists tasks in project no filter', async () => {
            const labelSelectors = [
                tpl('fabric.project', projectId),
            ];
            const listTasksPath = K8S_URLS.resourceList(apiVersion, kind, getNamespace(), labelSelectors);
            const listTasksResponse: any = yaml.load(fs.readFileSync('test/data/tasks/k8s-tasklist.yaml').toString());
            nock(serverUrl)
                .get(listTasksPath)
                .reply(200, listTasksResponse);
            const { tasks: tasksResp } = await taskCtrl.listTasks(projectId);
            chai.expect(tasksResp.length).to.equal(7);
            checkAll(tasksResp, checkTaskListEntry);
        });
        // No longer supported via k8s
        it('lists tasks in project actionName', async () => {
            const actionName = 'jobAction1';
            const labelSelectors = [
                tpl('fabric.project', projectId),
            ];
            const listTasksPath = K8S_URLS.resourceList(apiVersion, kind, getNamespace(), labelSelectors);
            const listTasksResponse: any = yaml.load(fs.readFileSync('test/data/tasks/k8s-tasklist.yaml').toString());
            // Just test that the selector is passed as expected
            nock(serverUrl)
                .get(listTasksPath)
                .reply(200, listTasksResponse);
            const { tasks: taskList } = await taskCtrl.listTasks(projectId, actionName);
            chai.expect(taskList.length).to.equal(1);
            chai.expect(taskList[0]).to.have.property('actionName').equal(actionName);
        });
        it('lists tasks in project skillName', async () => {
            const skillName = 'jobSkill';
            const labelSelectors = [
                tpl('fabric.project', projectId),
            ];
            const listTasksPath = K8S_URLS.resourceList(apiVersion, kind, getNamespace(), labelSelectors);
            const listTasksResponse: any = yaml.load(fs.readFileSync('test/data/tasks/k8s-tasklist.yaml').toString());
            // Just test that the selector is passed as expected
            nock(serverUrl)
                .get(listTasksPath)
                .reply(200, listTasksResponse);
            const { tasks: taskList } = await taskCtrl.listTasks(projectId, undefined, undefined, undefined, skillName);
            chai.expect(taskList.length).to.equal(1);
            chai.expect(taskList[0]).to.have.property('skillName').equal(skillName);
        });
        it('lists tasks in project scheduled', async () => {
            const skillName = 'sys-invoke-skill';
            const actionName = 'invoke';
            const labelSelectors = [
                tpl('fabric.project', projectId),
            ];
            const listTasksPath = K8S_URLS.resourceList(apiVersion, kind, getNamespace(), labelSelectors);
            const listTasksResponse: any = yaml.load(fs.readFileSync('test/data/tasks/k8s-tasklist.yaml').toString());
            // Just test that the selector is passed as expected
            nock(serverUrl).persist()
                .get(listTasksPath)
                .reply(200, listTasksResponse);
            const tests: [any, number][] = [
                [{ scheduled: true }, 1],
                [{ scheduled: true, skillName }, 1],
                [{ scheduled: true, actionName }, 1],
                [{ scheduled: true, skillName, actionName }, 1],
                // test that multiple filters work
                [{ scheduled: true, skillName: 'nothere' }, 0],
                [{ scheduled: true, actionName: 'nothere' }, 0],
                [{ scheduled: true, skillName, actionName: 'nothere' }, 0],
                [{ scheduled: true, skillName: 'nothere', actionName }, 0],
            ];
            await Promise.all(tests.map(async ([filter, cnt]) => {
                const { tasks: taskList } = await taskCtrl.taskCtl.listTasks(projectId, { filter });
                chai.expect(taskList.length)
                    .to
                    .equal(cnt);
                if (cnt > 0) {
                    chai.expect(taskList[0])
                        .to
                        .have
                        .property('skillName')
                        .equal(skillName);
                    chai.expect(taskList[0])
                        .to
                        .have
                        .property('actionName')
                        .equal(actionName);
                    chai.expect(taskList[0])
                        .to
                        .have
                        .property('schedule');
                }
            }));
        });
        it('empty list tasks in project bad skillName', async () => {
            const skillName = 'nothere';
            const labelSelectors = [
                tpl('fabric.project', projectId),
            ];
            const listTasksPath = K8S_URLS.resourceList(apiVersion, kind, getNamespace(), labelSelectors);
            const listTasksResponse: any = yaml.load(fs.readFileSync('test/data/tasks/k8s-tasklist.yaml').toString());
            // Just test that the selector is passed as expected
            nock(serverUrl)
                .get(listTasksPath)
                .reply(200, listTasksResponse);
            const { tasks: taskList } = await taskCtrl.listTasks(projectId, undefined, undefined, undefined, undefined, undefined, undefined, undefined, { skillName }, undefined, undefined);
            chai.expect(taskList.length).to.equal(0);
        });
        it('validate query params', async () => {
            const tests = [
                { scheduled: 'foo' },
                { limit: 'foo' },
                { skip: 'foo' },
            ].map(async (filter) => {
                await request(server.app)
                    .get(`/fabric/v4/projects/${projectId}/tasks?${qs.stringify(filter)}`)
                    .set('Accept', 'application/json')
                    .set('Authorization', getAuthHeader())
                    .then((res) => checkResponse(res, 400, false));
            });
            await Promise.all(tests);
        });
        it('empty list tasks in project bad actionName', async () => {
            const actionName = 'nothere';
            const labelSelectors = [
                tpl('fabric.project', projectId),
            ];
            const listTasksPath = K8S_URLS.resourceList(apiVersion, kind, getNamespace(), labelSelectors);
            const listTasksResponse: any = yaml.load(fs.readFileSync('test/data/tasks/k8s-tasklist.yaml').toString());
            // Just test that the selector is passed as expected
            nock(serverUrl)
                .get(listTasksPath)
                .reply(200, listTasksResponse);
            const { tasks: taskList } = await taskCtrl.listTasks(projectId, actionName);
            chai.expect(taskList.length).to.equal(0);
        });

        it('empty list in a project with no tasks', async () => {
            const badProjectId = 'invalidProject';
            const labelSelectors = [
                tpl('fabric.project', badProjectId),
            ];
            const listTasksPath = K8S_URLS.resourceList(apiVersion, kind, getNamespace(), labelSelectors);
            nock(serverUrl)
                .get(listTasksPath)
                .reply(200, {
                    items: [], kind, metadata: [], apiVersion,
                });
            const { tasks: taskResp } = await taskCtrl.listTasks(badProjectId);
            chai.expect(taskResp.length).to.equal(0);
        });
        it('k8s api returning no items array', async () => {
            const labelSelectors = [
                tpl('fabric.project', projectId),
            ];
            const listTasksPath = K8S_URLS.resourceList(apiVersion, kind, getNamespace(), labelSelectors);
            nock(serverUrl)
                .get(listTasksPath)
                .reply(200, { kind, metadata: [], apiVersion });
            const { tasks: taskResp } = await taskCtrl.listTasks(projectId);
            chai.expect(taskResp.length).to.equal(0);
        });
        it('k8s api throws an error', async () => {
            const labelSelectors = [
                tpl('fabric.project', projectId),
            ];
            const listTasksPath = K8S_URLS.resourceList(apiVersion, kind, getNamespace(), labelSelectors);
            nock(serverUrl)
                .get(listTasksPath)
                .reply(404);
            try {
                await taskCtrl.listTasks(projectId, {});
                Assert.fail('Should fail');
            } catch (err) {
                chai.expect(err).to.haveOwnProperty('output').haveOwnProperty('statusCode').equal(500);
            }
        });

        it('k8s api throws an 500', async () => {
            const labelSelectors = [
                tpl('fabric.project', projectId),
            ];
            const listTasksPath = K8S_URLS.resourceList(apiVersion, kind, getNamespace(), labelSelectors);
            nock(serverUrl)
                .get(listTasksPath)
                .reply(500);
            try {
                await taskCtrl.listTasks(projectId);
                Assert.fail('Should fail');
            } catch (err) {
                chai.expect(err).to.haveOwnProperty('output').haveOwnProperty('statusCode').equal(500);
            }
        });
    });

    describe('DESCRIBE', () => {
        it('fetches a task', async () => {
            const taskName = 'composetests-success-job-skill-success-job-79ttq';
            const resourceResponse = tasks[taskName];
            nock(serverUrl).get(K8S_URLS.resources(apiVersion, kind, getNamespace(), taskName)).reply(200, resourceResponse);
            const { task } = await taskCtrl.getTask(projectId, taskName);
            // TODO verify response body
            // eslint-disable-next-line no-unused-expressions
            chai.expect(task.name).to.equal(taskName);
            // eslint-disable-next-line no-unused-expressions
            chai.expect(task.k8s).to.not.exist;
            // eslint-disable-next-line no-unused-expressions
            chai.expect(task.state).to.exist;
        });

        it('fetches a task with k8s option', async () => {
            const taskName = '4da2dd49-9467-40fc-955f-a89df88c5194';
            const resourceResponse = tasks[taskName];
            nock(serverUrl).get(K8S_URLS.resources(apiVersion, kind, getNamespace(), taskName)).reply(200, resourceResponse);
            const { task } = await taskCtrl.getTask(projectId, taskName, true);
            logger.debug(`body: ${JSON.stringify(task)}`);
            // todo verify response body
            // eslint-disable-next-line no-unused-expressions
            chai.expect(task.name).to.equal(taskName);
            // eslint-disable-next-line no-unused-expressions
            chai.expect(task.k8s).to.exist;
            // eslint-disable-next-line no-unused-expressions
            chai.expect(task.spec).to.not.exist;
            // eslint-disable-next-line no-unused-expressions
            chai.expect(task.resource).to.not.exist;
        });

        it('unable to fetch a task in the wrong project', async () => {
            const taskName = 'unique-task';
            const resourceResponse = tasks[taskName];
            nock(serverUrl).get(K8S_URLS.resources(apiVersion, kind, getNamespace(), taskName)).reply(200, resourceResponse);
            try {
                await taskCtrl.getTask(projectId, taskName, true);
                Assert.fail('Should fail');
            } catch (err) {
                chai.expect(err).to.haveOwnProperty('output').haveOwnProperty('statusCode').equal(404);
            }
        });

        it('unable to fetch a task in that DNE', async () => {
            const taskName = 'invalid-task-name';
            const { req } = mocks.createMocks({
                params: {
                    projectId,
                    name: taskName,
                },
                query: {
                    k8s: true,
                },
            });
            req.jwt = 'xxxxxxxxxxx';
            nock(serverUrl).get(K8S_URLS.resources(apiVersion, kind, getNamespace(), taskName)).reply(200, {});
            try {
                await taskCtrl.getTask(projectId, taskName, true);
                Assert.fail('Should fail');
            } catch (err) {
                chai.expect(err).to.haveOwnProperty('output').haveOwnProperty('statusCode').equal(404);
            }
        });

        it('k8s api throws a 404', async () => {
            const taskName = 'invalid-task-name';
            nock(serverUrl).get(K8S_URLS.resources(apiVersion, kind, getNamespace(), taskName)).reply(404);
            try {
                await taskCtrl.getTask(projectId, taskName, true);
                Assert.fail('Should fail');
            } catch (err) {
                chai.expect(err).to.haveOwnProperty('output').haveOwnProperty('statusCode').equal(404);
            }
        });

        it('k8s api throws a 501', async () => {
            const taskName = 'invalid-task-name';
            nock(serverUrl).get(K8S_URLS.resources(apiVersion, kind, getNamespace(), taskName)).reply(501);
            try {
                await taskCtrl.getTask(projectId, taskName, true);
                Assert.fail('Should fail');
            } catch (err) {
                chai.expect(err).to.haveOwnProperty('output').haveOwnProperty('statusCode').equal(501);
            }
        });

        it('k8s api returns malformed response', async () => {
            const taskName = '4da2dd49-9467-40fc-955f-a89df88c5194';
            nock(serverUrl).get(K8S_URLS.resources(apiVersion, kind, getNamespace(), taskName)).reply(200, {});
            try {
                await taskCtrl.getTask(projectId, taskName, true);
                Assert.fail('Should fail');
            } catch (err) {
                chai.expect(err).to.haveOwnProperty('output').haveOwnProperty('statusCode').equal(404);
            }
        });
    });

    describe('LOGS', () => {
        const sandbox = sinon.createSandbox();
        afterEach(async () => {
            sandbox.restore();
        });
        const containerName = 'fabric-action';
        it('query task logs', async () => {
            const taskName = '4da2dd49-9467-40fc-955f-a89df88c5194';
            const labelSelectors = [
                tpl('job-name', taskName),
                tpl('fabric.project', projectId),
            ];
            let logsPath = K8S_URLS.pods(getNamespace(), labelSelectors);
            const dummyPod = {
                metadata: {
                    name: taskName,
                    annotations: {
                        'kubectl.kubernetes.io/default-logs-container': 'fabric-action',
                    },
                },
            };
            // check for existence of task (and if it's in the expected project)
            nock(serverUrl).get(K8S_URLS.resources(apiVersion, kind, getNamespace(), taskName)).reply(200, tasks[taskName]);
            nock(serverUrl)
                .get(logsPath)
                .reply(200, dummyPod);
            labelSelectors.push(tpl('container', containerName));
            logsPath = K8S_URLS.podLogs(taskName, getNamespace(), labelSelectors);
            nock(serverUrl)
                .get(logsPath)
                .reply(200, {
                    items: [], kind, metadata: [], apiVersion,
                });
            // Stubbing the getTask method to return 'active task state'
            sandbox.stub(taskCtrl.taskCtl, 'getTask').resolves({ task: { state: 'ACTIVE' } });

            const req = mocks.createRequest();
            const body = await taskCtrl.getTaskLogs(req, projectId, taskName, false);
            chai.expect(body.logs).to.deep.equal('');
        });
        it('query non-existing task logs', async () => {
            const taskName = 'doesnt-exist';
            const labelSelectors = [
                tpl('job-name', taskName),
                tpl('fabric.project', projectId),
            ];
            // check for existence of task (and if it's in the expected project)
            nock(serverUrl).get(K8S_URLS.resources(apiVersion, kind, getNamespace(), taskName)).reply(200, tasks[taskName]);
            const logsPath = K8S_URLS.pods(getNamespace(), labelSelectors);
            nock(serverUrl)
                .get(logsPath)
                .reply(200, {});
            try {
                const req = mocks.createRequest();
                await taskCtrl.getTaskLogs(req, projectId, taskName, false);
                Assert.fail('Should fail');
            } catch (err: any) {
                chai.expect(err).to.haveOwnProperty('output').haveOwnProperty('statusCode').equal(404);
                const errorMessage = `Task ${taskName} not found in project ${projectId}`;
                chai.expect(err.message).to.contain(errorMessage);
            }
        });
        it('k8s api returns 404', async () => {
            const taskName = 'doesnt-exist';
            const labelSelectors = [
                tpl('job-name', taskName),
                tpl('fabric.project', projectId),
            ];
            const logsPath = K8S_URLS.pods(getNamespace(), labelSelectors);
            nock(serverUrl)
                .get(logsPath)
                .reply(200, {});
            // check for existence of task (and if it's in the expected project)
            nock(serverUrl).get(K8S_URLS.resources(apiVersion, kind, getNamespace(), taskName)).reply(404);
            try {
                const req = mocks.createRequest();
                await taskCtrl.getTaskLogs(req, projectId, taskName, false);
                Assert.fail('Should fail');
            } catch (err: any) {
                chai.expect(err).to.haveOwnProperty('output').haveOwnProperty('statusCode').equal(404);
                const errorMessage = 'not found';
                chai.expect(err.message).to.contain(errorMessage);
            }
        });

        // not sure on this test, should return 404 as task doesn't exist.
        it('k8s api returns 501', async () => {
            const taskName = 'doesnt-exist';
            const labelSelectors = [
                tpl('job-name', taskName),
                tpl('fabric.project', projectId),
            ];
            const logsPath = K8S_URLS.pods(getNamespace(), labelSelectors);
            nock(serverUrl)
                .get(logsPath)
                .reply(501, {});
            nock(serverUrl).get(K8S_URLS.resources(apiVersion, kind, getNamespace(), taskName)).reply(404);
            try {
                const req = mocks.createRequest();
                await taskCtrl.getTaskLogs(req, projectId, taskName, false);
                Assert.fail('Should fail');
            } catch (err: any) {
                chai.expect(err).to.haveOwnProperty('output').haveOwnProperty('statusCode').equal(404);
                const errorMessage = 'not found';
                chai.expect(err.message).to.include(errorMessage);
            }
        });
        // return 404 as there is no task data to checkProject..
        it('k8s api returns malformed response', async () => {
            const taskName = 'doesnt-exist';
            const labelSelectors = [
                tpl('job-name', taskName),
                tpl('fabric.project', projectId),
            ];
            const logsPath = K8S_URLS.pods(getNamespace(), labelSelectors);
            nock(serverUrl)
                .get(logsPath)
                .reply(200, {});
            // check for existence of task (and if it's in the expected project)
            nock(serverUrl).get(K8S_URLS.resources(apiVersion, kind, getNamespace(), taskName)).reply(200, {});
            try {
                const req = mocks.createRequest();
                await taskCtrl.getTaskLogs(req, projectId, taskName, false);
                Assert.fail('Should fail');
            } catch (err: any) {
                chai.expect(err).to.haveOwnProperty('output').haveOwnProperty('statusCode').equal(404);
                const errorMessage = `Task ${taskName} not found in project ${projectId}`;
                chai.expect(err.message).to.include(errorMessage);
            }
        });
        it('should return live sse event logs when task is active and follow is true', async () => {
            const taskName = '4da2dd49-9467-40fc-955f-a89df88c5194';
            const labelSelectors = [
                tpl('job-name', taskName),
                tpl('fabric.project', projectId),
            ];
            let logsPath = K8S_URLS.pods(getNamespace(), labelSelectors);
            const dummyPod = {
                metadata: {
                    name: taskName,
                    annotations: {
                        'kubectl.kubernetes.io/default-logs-container': 'fabric-action',
                    },
                },
            };
            // check for existence of task (and if it's in the expected project)
            nock(serverUrl).get(K8S_URLS.resources(apiVersion, kind, getNamespace(), taskName)).reply(200, tasks[taskName]);
            nock(serverUrl)
                .get(logsPath)
                .reply(200, dummyPod);
            labelSelectors.push(tpl('container', containerName));

            // Stubbing the getTask method to return 'active task state'
            sandbox.stub(taskCtrl.taskCtl, 'getTask').resolves({ task: { state: 'ACTIVE' } });

            const mockedSSEData = 'Mocked SSE event data';
            const sseStream = new Readable();
            sseStream._read = () => { }; // Necessary for Readable streams
            sseStream.push(`data: ${mockedSSEData}\n\n`); // Push SSE event data
            sseStream.push(null); // End the stream

            logsPath = K8S_URLS.podLiveLogs(taskName, getNamespace());
            nock(serverUrl)
                .get(logsPath)
                .reply(200, sseStream, { 'Content-Type': 'text/event-stream' }); // Mocking SSE events

            const req = mocks.createRequest();
            const res = mocks.createResponse();
            req.res = res;

            const body = await taskCtrl.getTaskLogs(req, projectId, taskName, false, true);

            chai.expect(body).to.be.an.instanceOf(Readable);
            body.on('data', (chunk) => {
                const receivedData = chunk.toString();
                chai.expect(receivedData).to.equal(`data: ${mockedSSEData}\n\n`);
            });
        });
        it('should return logs when task is active and follow is false or not defined', async () => {
            const taskName = '4da2dd49-9467-40fc-955f-a89df88c5194';
            const labelSelectors = [
                tpl('job-name', taskName),
                tpl('fabric.project', projectId),
            ];
            let logsPath = K8S_URLS.pods(getNamespace(), labelSelectors);
            const dummyPod = {
                metadata: {
                    name: taskName,
                    annotations: {
                        'kubectl.kubernetes.io/default-logs-container': 'fabric-action',
                    },
                },
            };
            // check for existence of task (and if it's in the expected project)
            nock(serverUrl).get(K8S_URLS.resources(apiVersion, kind, getNamespace(), taskName)).reply(200, tasks[taskName]);
            nock(serverUrl)
                .get(logsPath)
                .reply(200, dummyPod);
            labelSelectors.push(tpl('container', containerName));

            // Stubbing the getTask method to return 'active task state'
            sandbox.stub(taskCtrl.taskCtl, 'getTask').resolves({ task: { state: 'ACTIVE' } });

            logsPath = K8S_URLS.podLiveLogs(taskName, getNamespace());
            nock(serverUrl)
                .get(logsPath)
                .reply(200, {
                    items: [], kind, metadata: [], apiVersion,
                });

            const req = mocks.createRequest();

            const body = await taskCtrl.getTaskLogs(req, projectId, taskName, false, false);

            chai.expect(body.logs).to.deep.equal('');
        });
        it('should return logs when task is not active and follow is true', async () => {
            const taskName = '4da2dd49-9467-40fc-955f-a89df88c5194';
            const labelSelectors = [
                tpl('job-name', taskName),
                tpl('fabric.project', projectId),
            ];
            let logsPath = K8S_URLS.pods(getNamespace(), labelSelectors);
            const dummyPod = {
                metadata: {
                    name: taskName,
                    annotations: {
                        'kubectl.kubernetes.io/default-logs-container': 'fabric-action',
                    },
                },
            };
            // check for existence of task (and if it's in the expected project)
            nock(serverUrl).get(K8S_URLS.resources(apiVersion, kind, getNamespace(), taskName)).reply(200, tasks[taskName]);
            nock(serverUrl)
                .get(logsPath)
                .reply(200, dummyPod);
            labelSelectors.push(tpl('container', containerName));

            // Stubbing the getTask method to return 'completed task state'
            sandbox.stub(taskCtrl.taskCtl, 'getTask').resolves({ task: { state: 'Completed' } });

            logsPath = K8S_URLS.podLiveLogs(taskName, getNamespace());
            nock(serverUrl)
                .get(logsPath)
                .reply(200, {
                    items: [], kind, metadata: [], apiVersion,
                });

            // mock managed content download request
            nock('http://localhost:8888')
                .get(`/fabric/v4/projects/${projectId}/content/tasks/${taskName}/logs.json`)
                .reply(200, 'dummyLog');

            const req = mocks.createRequest();

            const body = await taskCtrl.getTaskLogs(req, projectId, taskName, false, true);

            chai.expect(body.logs).to.deep.equal('dummyLog');
        });
    });
    describe('DELETE', () => {
        it('delete a task', async () => {
            const taskName = '4da2dd49-9467-40fc-955f-a89df88c5194';
            const resourceResponse = tasks[taskName];
            nock(serverUrl).get(K8S_URLS.resources(apiVersion, kind, getNamespace(), taskName)).reply(200, resourceResponse);
            nock(serverUrl).delete(K8S_URLS.resources(apiVersion, kind, getNamespace(), taskName)).reply(200, resourceResponse);
            const { message } = await taskCtrl.deleteTask(projectId, taskName);
            chai.expect(message).to.deep.equal(`Successfully marked task ${taskName} for delete`);
        });
        it('not allowed to delete task in different project', async () => {
            const taskName = 'unique-task';
            const resourceResponse = tasks[taskName];
            nock(serverUrl).get(K8S_URLS.resources(apiVersion, kind, getNamespace(), taskName)).reply(200, resourceResponse);
            try {
                await taskCtrl.deleteTask(projectId, taskName);
                Assert.fail('Should fail');
            } catch (err: any) {
                chai.expect(err).to.haveOwnProperty('output').haveOwnProperty('statusCode').equal(404);
                const errorMessage = `Task ${taskName} not found in project ${projectId}`;
                chai.expect(err.message).to.include(errorMessage);
            }
        });
        it('delete a task that DNE', async () => {
            const taskName = 'doesnt-exist';
            nock(serverUrl).get(K8S_URLS.resources(apiVersion, kind, getNamespace(), taskName)).reply(404, {});
            try {
                await taskCtrl.deleteTask(projectId, taskName);
                Assert.fail('Should fail');
            } catch (err: any) {
                chai.expect(err).to.haveOwnProperty('output').haveOwnProperty('statusCode').equal(404);
                const errorMessage = `Task ${taskName} not found in project ${projectId}`;
                chai.expect(err.message).to.include(errorMessage);
            }
        });
        describe('checking task exists', () => {
            it('k8s api returns malformed response', async () => {
                const taskName = 'doesnt-exist';
                nock(serverUrl).get(K8S_URLS.resources(apiVersion, kind, getNamespace(), taskName)).reply(200, {});
                try {
                    await taskCtrl.deleteTask(projectId, taskName);
                    Assert.fail('Should fail');
                } catch (err: any) {
                    chai.expect(err).to.haveOwnProperty('output').haveOwnProperty('statusCode').equal(404);
                    const errorMessage = `Task ${taskName} not found in project ${projectId}`;
                    chai.expect(err.message).to.include(errorMessage);
                }
            });
            it('k8s api returns 404', async () => {
                const taskName = 'doesnt-exist';
                nock(serverUrl).get(K8S_URLS.resources(apiVersion, kind, getNamespace(), taskName)).reply(404);
                try {
                    await taskCtrl.deleteTask(projectId, taskName);
                    Assert.fail('Should fail');
                } catch (err: any) {
                    chai.expect(err).to.haveOwnProperty('output').haveOwnProperty('statusCode').equal(404);
                    const errorMessage = `Task ${taskName} not found in project ${projectId}`;
                    chai.expect(err.message).to.include(errorMessage);
                }
            });
            it('k8s api returns 501', async () => {
                const taskName = 'doesnt-exist';
                nock(serverUrl).get(K8S_URLS.resources(apiVersion, kind, getNamespace(), taskName)).reply(501);
                try {
                    await taskCtrl.deleteTask(projectId, taskName);
                    Assert.fail('Should fail');
                } catch (err: any) {
                    chai.expect(err).to.haveOwnProperty('output').haveOwnProperty('statusCode').equal(501);
                    const errorMessage = 'Error getting task';
                    chai.expect(err.message).to.include(errorMessage);
                }
            });
        });
        describe('deleting task', () => {
            it('k8s api returns malformed response', async () => {
                const taskName = '4da2dd49-9467-40fc-955f-a89df88c5194';
                const resourceResponse = tasks[taskName];
                nock(serverUrl).get(K8S_URLS.resources(apiVersion, kind, getNamespace(), taskName)).reply(200, resourceResponse);
                nock(serverUrl).delete(K8S_URLS.resources(apiVersion, kind, getNamespace(), taskName)).reply(200, {});
                const { message } = await taskCtrl.deleteTask(projectId, taskName);
                chai.expect(message).to.deep.equal(`Successfully marked task ${taskName} for delete`);
            });
            it('k8s api returns 404', async () => {
                const taskName = '4da2dd49-9467-40fc-955f-a89df88c5194';
                const resourceResponse = tasks[taskName];
                nock(serverUrl).get(K8S_URLS.resources(apiVersion, kind, getNamespace(), taskName)).reply(200, resourceResponse);
                nock(serverUrl).delete(K8S_URLS.resources(apiVersion, kind, getNamespace(), taskName)).reply(404);
                try {
                    await taskCtrl.deleteTask(projectId, taskName);
                    Assert.fail('Should fail');
                } catch (err: any) {
                    chai.expect(err).to.haveOwnProperty('output').haveOwnProperty('statusCode').equal(404);
                    const errorMessage = `Task ${taskName} not found in project ${projectId}`;
                    chai.expect(err.message).to.include(errorMessage);
                }
            });
            it('k8s api returns 501', async () => {
                const taskName = '4da2dd49-9467-40fc-955f-a89df88c5194';
                const resourceResponse = tasks[taskName];
                nock(serverUrl).get(K8S_URLS.resources(apiVersion, kind, getNamespace(), taskName)).reply(200, resourceResponse);
                nock(serverUrl).delete(K8S_URLS.resources(apiVersion, kind, getNamespace(), taskName)).reply(501);
                try {
                    await taskCtrl.deleteTask(projectId, taskName);
                    Assert.fail('Should fail');
                } catch (err: any) {
                    chai.expect(err).to.haveOwnProperty('output').haveOwnProperty('statusCode').equal(501);
                    const errorMessage = 'Error deleting task';
                    chai.expect(err.message).to.include(errorMessage);
                }
            });
        });
    });
    describe('cron validator', () => {
        it('valid cron strs', () => {
            [
                '* * * * *',
                '@hourly',
                '@annually',
                '@midnight',
                '@weekly',
                '@yearly',
                '@every 99h99m99s',
                '@every 10m',
                '0 0 1 * *',
                '*/10 * * * *',
                '*/10 * * 1 1',
                '*/10 * * * MON',
                '*/10 * * JAN TUE,WED',
                '*/10 * ? JAN-JUN TUE-WED',
            ].forEach((s) => {
                validateCron(s);
            });
        });
        it('invalid cron strs', () => {
            [
                '* * * * * *',
                '@foobar',
                '@annualy',
                '@every 10m5ms',
                '@every 5us',
                '0 0 0 * *',
                '99 * * * *',
                '* 25 * 1 1',
                '* 1am * * MON',
                '*/10 * * JAN TUE,NOPE',
                '*/10 * * JAN 7',
                '*/10 * ? 13 1/8',
            ].forEach((s) => {
                chai.expect(() => validateCron(s), `${s} should throw error`).to.throw(boom.Boom);
            });
        });
    });
});
