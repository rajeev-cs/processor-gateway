import config from 'config';
import chai from 'chai';
import assert from 'assert';
import chaiAsPromised from 'chai-as-promised';
import nock from 'nock';
import { RuntimeProvider } from '../lib/actions/runtimeProvider.js';
import { ResourceProvider } from '../lib/clients/resourceProvider.js';
import Infra from '../lib/interfaces/Infra.js';
import { mockLogger } from './testutil/index.js';
// set before loading config.js...
process.env.KUBECONFIG = './test/data/kubeconfig-c12e-ci';

const { expect } = chai;
chai.use(chaiAsPromised);
const projectId = 'actionTestProj';
const { namespace } = config.kubernetes;

// Simple mock resource provider
const resourceProvider = new ResourceProvider();
const runtimeProvider = new RuntimeProvider(new Infra({ redis: {}, logger: mockLogger() }));

function mockSkillsList(skillList) {
    resourceProvider.getSkill = (project, name) => {
        const skill = skillList?.[name.toLowerCase()]?.spec;
        if (skill) skill.name = `${project}-${name}`;
        return skill;
    };
    return resourceProvider;
}

/* eslint-disable no-unused-expressions */ // needed for expect .to.be.rejected
describe('test action invoke', () => {
    before(() => {
        if (!nock.isActive()) {
            nock.activate();
        }
    });
    after(() => {
        delete process.env.KUBECONFIG;
        // clean up mocks that may not have been called
        nock.cleanAll();
    });
    afterEach(() => {
        runtimeProvider.flushProviders();
    });
    it('test daemon invoke default path/port', async () => {
        const skillName = 'skillname';
        const actionName = 'actionname';
        const hostname = `http://${projectId.toLowerCase()}-${skillName.toLowerCase()}-${actionName.toLowerCase()}.${namespace}.svc.cluster.local:8080`;
        const body = { value: 'dflt' };
        nock(hostname)
            .post('/invoke')
            .reply(200, { payload: body });
        const skillList = {
            skillname: {
                spec: {
                    actions: [
                        {
                            name: actionName,
                            type: 'daemon',
                        },
                    ],
                },
            },
        };
        const provider = await runtimeProvider.getRuntime('cortex/daemons', mockSkillsList(skillList));
        const res = await provider.invoke(projectId, skillName, actionName, {});
        expect(res.payload).to.deep.equal(body);
    });
    it('test daemon invoke POST', async () => {
        const actionName = 'actionname';
        const skillName = 'skillname';
        // TODO get from skill params..
        const port = 8080;
        const path = '/invoke';
        const hostname = `http://${projectId.toLowerCase()}-${skillName.toLowerCase()}-${actionName.toLowerCase()}.${namespace}.svc.cluster.local:${port}`;
        const body = { value: 'key1Value' };
        nock(hostname)
            .post(path)
            .reply(200, { payload: body });
        const skillList = {
            skillname: {
                spec: {
                    actions: [
                        {
                            name: actionName,
                            type: 'daemon',
                            path,
                            port,
                            method: 'POST',
                        },
                    ],
                },
            },
        };
        const provider = await runtimeProvider.getRuntime('cortex/daemons', mockSkillsList(skillList));
        const res = await provider.invoke(projectId, skillName, actionName, body);
        expect(res.payload).to.deep.equal(body);
    });
    it('test daemon invoke missing action', async () => {
        const skillName = 'skillname';
        const actionName = 'notfound';
        const body = { value: 'dflt' };
        const skillList = {
            skillname: {
                spec: {
                    actions: [
                        {
                            name: 'SOMETHINGELSE',
                            type: 'daemon',
                        },
                    ],
                },
            },
        };
        try {
            const provider = await runtimeProvider.getRuntime('cortex/daemons', mockSkillsList(skillList));
            await provider.invoke(projectId, skillName, actionName, body);
            assert.fail('Shouldn\'t get here');
        } catch (err: any) {
            // This is a network issue..  we don't check skill for actions...
            expect(err.message).to.include(`action ${actionName} not found`);
        }
    });
    it('test daemon invoke missing skill', async () => {
        const skillName = 'nothere';
        const actionName = 'actionname';
        const body = { value: 'dflt' };
        const skillList = {
            skillname: {
                spec: {
                    actions: [
                        {
                            name: actionName,
                            type: 'daemon',
                        },
                    ],
                },
            },
        };
        try {
            const provider = await runtimeProvider.getRuntime('cortex/daemons', mockSkillsList(skillList));
            await provider.invoke(projectId, skillName, actionName, body);
            assert.fail('Shouldn\'t get here');
        } catch (err: any) {
            expect(err.message).to.include(`skill ${skillName} not found`);
        }
    });
    it('test job invoke', async () => {
        const skillName = 'job-skill';
        const actionName = 'job-good';
        const body = { token: 'jwt-token', activationId: 'activation-id', payload: { text: 'My payload' } };
        nock('http://server.com')
            .post('/apis/fabric.cognitivescale.com/v1/namespaces/cortex/tasks')
            .reply(200, body);
        const skillList = {
            'job-skill': {
                spec: {
                    actions: [
                        {
                            name: actionName,
                            type: 'job',
                        },
                    ],
                },
            },
        };
        try {
            const provider = await runtimeProvider.getRuntime('cortex/daemons', mockSkillsList(skillList));
            await provider.invoke(projectId, skillName, actionName, body);
        } catch (ex: any) {
            console.error(ex?.response?.body || ex.message);
        }
    });
    it('test job missing skill', async () => {
        const skillName = 'not-Here';
        const actionName = 'job-good';
        const body = { token: 'jwt-token', activationId: 'activation-id', payload: { text: 'My payload' } };
        const skillList = {
            'job-skill': {
                spec: {
                    actions: [
                        {
                            name: actionName,
                            type: 'job',
                        },
                    ],
                },
            },
        };
        const provider = await runtimeProvider.getRuntime('cortex/daemons', mockSkillsList(skillList));
        try {
            await provider.invoke(projectId, skillName, actionName, body);
            assert.fail('Should not get here');
        } catch (err: any) {
            expect(err.message).to.include(`skill ${skillName} not found`);
        }
    });
    it('test job missing action', async () => {
        const skillName = 'job-skill';
        const actionName = 'not-here';
        const body = { token: 'jwt-token', activationId: 'activation-id', payload: { text: 'My payload' } };
        const skillList = {
            'job-skill': {
                spec: {
                    actions: [
                        {
                            name: 'job-good',
                            type: 'job',
                        },
                    ],
                },
            },
        };
        const provider = await runtimeProvider.getRuntime('cortex/daemons', mockSkillsList(skillList));
        try {
            await provider.invoke(projectId, skillName, actionName, body);
            assert.fail('Should not get here');
        } catch (err: any) {
            expect(err.message).to.include(`action ${actionName} not found`);
        }
    });
    it('test http invoke POST ', async () => {
        const payload = { text: 'My payload' };
        const skillName = 'skillname';
        const url = 'http://externalserver:9999';
        const path = '/some/path';
        const extApiBody = { text: 'got here' };
        nock(url, {
            reqheaders: {
                authorization: () => true,
                'content-type': () => true,
            },
        })
            .post(path, payload) // payload received should equal request payload
            .reply(200, extApiBody);
        const body = {
            properties: {
                'headers.content-type': 'application/json',
                'headers.authorization': 'bearer foo-bar',
                url,
                path,
            },
            token: 'jwt-token',
            activationId: 'activation-id',
            payload,
        };
        const skillList = {
            skillname: {
                spec: {},
            },
        };
        const provider = await runtimeProvider.getRuntime('cortex/external-api', mockSkillsList(skillList));
        const res = await provider.invoke(projectId, skillName, '', body);
        expect(res.payload).to.deep.equal(extApiBody);
        expect(res.async).to.equal(false);
    });
    it('test http invoke GET ', async () => {
        const skillName = 'skillname';
        const url = 'http://externalserver:9999';
        const path = '/some/path';
        const extApiBody = { text: 'got here' };
        nock(url, {
            reqheaders: {
                authorization: () => true,
                'content-type': () => true,
            },
        })
            .get(path) // payload received should equal request payload
            .reply(200, extApiBody);
        const body = {
            properties: {
                'headers.content-type': 'application/json',
                'headers.authorization': 'bearer foo-bar',
                url,
                path,
                method: 'GET',
            },
            token: 'jwt-token',
            activationId: 'activation-id',
            payload:  { text: 'My payload' },
        };
        const skillList = {
            skillname: {
                spec: {},
            },
        };
        const provider = await runtimeProvider.getRuntime('cortex/external-api', mockSkillsList(skillList));
        const res = await provider.invoke(projectId, skillName, '', body);
        expect(res.payload).to.deep.equal(extApiBody);
        expect(res.async).to.equal(false);
    });
    it('test http invoke GET, mustache ', async () => {
        const skillName = 'skillname';
        const url = 'http://externalserver:9999';
        const path = '/dynamic/13579';
        const extApiBody = { text: 'got here' };
        const extNock = nock(url, {
            reqheaders: {
                authorization: () => true,
                'content-type': () => true,
            },
        })
            .get(path) // payload received should equal request payload
            .reply(200, extApiBody);
        const body = {
            properties: {
                'headers.content-type': 'application/json',
                'headers.authorization': 'bearer foo-bar',
                url,
                path: '/{{properties.somePath}}/{{payload.someId}}',
                method: 'GET',
                somePath: 'dynamic',
            },
            token: 'jwt-token',
            activationId: 'activation-id',
            payload:  { text: 'My payload', someId: 13579 },
        };
        const skillList = {
            skillname: {
                spec: {},
            },
        };
        const provider = await runtimeProvider.getRuntime('cortex/external-api', mockSkillsList(skillList));
        const res = await provider.invoke(projectId, skillName, '', body);
        expect(res.payload).to.deep.equal(extApiBody);
        expect(res.async).to.equal(false);
        // eslint-disable-next-line @typescript-eslint/no-unused-expressions
        expect(extNock.pendingMocks()).to.be.empty;
    });
});
