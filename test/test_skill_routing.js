import assert from 'node:assert';
import config from 'config';
import fs from 'node:fs';
import yaml from 'js-yaml';
import { getLogger } from '@tt-sensa/sensa-express-common';
import importFresh from 'import-fresh';
import { Skill } from '../lib/skill.ts';
import { RuntimeProvider } from '../lib/actions/runtimeProvider.ts';
import { getToken } from './testutil/index.js';
import { FilesystemResource } from '../lib/clients/fileResources.js';

const token = getToken();
const logger = getLogger('gateway', config.get('logging'));
const projectId = 'skillTestProj';
const sessionId = 'sessionId';
const skillAgent = yaml.load(fs.readFileSync('./test/data/agents/Agent_Skill_Route_Tester.yml'));
// Added empty route.all: {} to emulate golang serializer behavior..
const skillPropRoute = yaml.load(fs.readFileSync('./test/data/skills/Skill_with_property_route.yaml'));
const skillFieldRoute = yaml.load(fs.readFileSync('./test/data/skills/Skill_with_field_route.yaml'));
const skillInvalidRoute = yaml.load(fs.readFileSync('./test/data/skills/Skill_with_invalid_route.yaml'));
const SecretClientMock = {
    getSecrets: async (key) => Promise.resolve(key),
};
/* eslint-disable no-console */
const synapseMock = {
    logger,
    runtimeProvider: new RuntimeProvider(),
    resourceProvider: new FilesystemResource({}),
};
describe('test skill routes', () => {
    //const sandbox = sinon.createSandbox();
    // sandbox.stub(Skill.prototype, 'invokeAction').callsFake((...parms) => {
    //     return {  payload: parms };
    // });
    before(async () => {
        await synapseMock.resourceProvider.initialize();
    });

    it('routes to actions based on property', async () => {
        const channelId = 'foo';
        skillAgent.skills[0].properties = [{ name: 'model', value: 'foo' }];
        const skill = new Skill(
            { agent: skillAgent },
            { ref: skillAgent.skills[0] }, skillPropRoute, synapseMock, SecretClientMock);
        const activation = {
            projectId,
            sessionId,
            agentName: skillAgent.name,
            processors: 'bar',
            processorName: 'baz',
            inputName: 'text',
            input: skillPropRoute.inputs[0],
            channelId,
        };
        const msg = {
            channelId,
            projectId,
            sessionId,
            token,
            payload: { text: 'test123' },
        };
        skillAgent.skills[0].properties = [{ name: 'model', value: 'bogo_val' }];  // no matching rule default
        let res = await skill.routeInput(activation, msg);
        assert.strictEqual(res.payload.actionname, 'unittest/default_func', 'Expect default function');
        skillAgent.skills[0].properties = [{ name: 'model', value: 'foo' }];
        res = await skill.routeInput(activation, msg);
        assert.strictEqual(res.payload.actionname, 'unittest/foo_func', 'Expect foo function');
        skillAgent.skills[0].properties = [{ name: 'model', value: 'bar' }];
        res = await skill.routeInput(activation, msg);
        assert.strictEqual(res.payload.actionname, 'unittest/bar_func', 'Expect bar function');
    });
    it('routes to actions based on property with retry-after', async () => {
        const channelId = 'foo';
        skillAgent.skills[0].properties = [{ name: 'model', value: 'foo' }];
        const skill = new Skill({ agent: skillAgent }, { ref: skillAgent.skills[0] }, skillPropRoute, synapseMock, SecretClientMock);
        const activation = {
            projectId,
            sessionId,
            processors: 'bar',
            processorName: 'baz',
            inputName: 'text',
            input: skillPropRoute.inputs[0],
            channelId,
        };
        const msg = {
            channelId,
            projectId,
            sessionId,
            token,
            payload: { text: 'test123' },
        };
        skillAgent.skills[0].properties = [{ name: 'model', value: 'bogo_val' }];
        let res = await skill.routeInput(activation, msg);
        assert.strictEqual(res.payload.actionname, 'unittest/default_func', 'Expect default function');
        skillAgent.skills[0].properties = [{ name: 'model', value: 'foo' }];
        res = await skill.routeInput(activation, msg);
        assert.strictEqual(res.payload.actionname, 'unittest/foo_func', 'Expect foo function');
        skillAgent.skills[0].properties = [{ name: 'model', value: 'bar' }];
        res = await skill.routeInput(activation, msg);
        assert.strictEqual(res.payload.actionname, 'unittest/bar_func', 'Expect bar function');
    });
    it('routes to actions based on field', async () => {
        const channelId = 'foo';
        skillAgent.skills[0].properties = [];
        const skill = new Skill({ agent: skillAgent }, { ref: skillAgent.skills[0] }, skillFieldRoute, synapseMock, SecretClientMock);
        const activation = {
            projectId,
            sessionId,
            processors: 'bar',
            processorName: 'baz',
            inputName: 'text',
            input: skillFieldRoute.inputs[0],
            channelId,
        };
        const msg = {
            channelId,
            projectId,
            sessionId,
            token,
            payload: { text: 'test123' },
        };
        msg.payload = { text: 'test123' };
        let res = await skill.routeInput(activation, msg);
        assert.strictEqual(res.payload.actionname, 'unittest/default_func', 'Expect default function');
        msg.payload = { text: 'test123', model: 'foo' };
        res = await skill.routeInput(activation, msg);
        assert.strictEqual(res.payload.actionname, 'unittest/foo_func', 'Expect foo function');
        msg.payload = { text: 'test123', model: 'bar' };
        res = await skill.routeInput(activation, msg);
        assert.strictEqual(res.payload.actionname, 'unittest/bar_func', 'Expect bar function');
    });
    it('throws if routing is invalid', async () => {
        const channelId = 'foo';
        skillAgent.skills[0].properties = [];
        const skill = new Skill({ agent: skillAgent }, { ref: skillAgent.skills[0] }, skillInvalidRoute, synapseMock, SecretClientMock);
        const activation = {
            projectId,
            sessionId,
            processors: 'bar',
            processorName: 'baz',
            inputName: 'text',
            input: skillInvalidRoute.inputs[0],
            channelId,
        };
        const msg = {
            channelId,
            projectId,
            sessionId,
            token,
            payload: { text: 'test123' },
        };
        msg.payload = { text: 'test123' };
        try {
            await skill.routeInput(activation, msg);
            assert.fail('Should have thrown');
        } catch (err) {
            assert.ok(err.message.includes('No matching route found'), 'Should throw no matching route');
        }
    });
});
describe('Skill invoke', () => {
    it('invalid skill input', async () => {
        const channelId = 'foo';
        skillAgent.skills[0].properties = [];
        const skill = new Skill({ agent: skillAgent }, { toInput: 'nothere', ref: { skillName: 'badinput' } }, skillInvalidRoute, synapseMock, SecretClientMock);
        const msg = {
            channelId,
            projectId,
            sessionId,
            token,
            payload: { text: 'test123' },
        };
        try {
            await skill.run(msg);
            assert.fail('Should have thrown');
        } catch (err) {
            assert.ok(err.message.includes('No skill input named "nothere"'));
        }
    });
});
describe('Action versioning', () => {
    describe('VERSION_ACTIONS=false', () => {
        before(() => {
            config.runtime.actions.versionActions = 'false';
        });

        after(() => {
            importFresh('config');
        });

        it('routes to actions based on property', async () => {
            const channelId = 'foo';
            skillAgent.skills[0].properties = [{ name: 'model', value: 'foo' }];
            const skill = new Skill({ agent: skillAgent }, { ref: skillAgent.skills[0] }, skillPropRoute, synapseMock, SecretClientMock);
            const activation = {
                projectId,
                sessionId,
                processors: 'bar',
                processorName: 'baz',
                inputName: 'text',
                input: skillPropRoute.inputs[0],
                channelId,
            };
            const msg = {
                channelId,
                projectId,
                sessionId,
                token,
                payload: { text: 'test123' },
            };
            skillAgent.skills[0].properties = [{ name: 'model', value: 'bogo_val' }];
            let res = await skill.routeInput(activation, msg);
            assert.strictEqual(res.payload.actionname, 'unittest/default_func', 'Expect default function');
            skillAgent.skills[0].properties = [{ name: 'model', value: 'foo' }];
            res = await skill.routeInput(activation, msg);
            assert.strictEqual(res.payload.actionname, 'unittest/foo_func', 'Expect foo function');
            skillAgent.skills[0].properties = [{ name: 'model', value: 'bar' }];
            res = await skill.routeInput(activation, msg);
            assert.strictEqual(res.payload.actionname, 'unittest/bar_func', 'Expect bar function');
        });
    });
    describe('VERSION_ACTIONS=true', () => {
        before(() => {
            config.runtime.actions.versionActions = 'true';
        });

        after(() => {
            importFresh('config');
        });

        it('routes to actions based on property', async () => {
            const channelId = 'foo';
            skillAgent.skills[0].properties = [{ name: 'model', value: 'foo' }];
            const skill = new Skill({ agent: skillAgent }, { ref: skillAgent.skills[0] }, skillPropRoute, synapseMock, SecretClientMock);
            const activation = {
                projectId,
                sessionId,
                processors: 'bar',
                processorName: 'baz',
                inputName: 'text',
                input: skillPropRoute.inputs[0],
                channelId,
            };
            const msg = {
                channelId,
                projectId,
                sessionId,
                token,
                payload: { text: 'test123' },
            };
            skillAgent.skills[0].properties = [{ name: 'model', value: 'bogo_val' }];
            let res = await skill.routeInput(activation, msg);
            assert.strictEqual(res.payload.actionname, 'unittest/default_func', 'Expect default function');
            skillAgent.skills[0].properties = [{ name: 'model', value: 'foo' }];
            res = await skill.routeInput(activation, msg);
            assert.strictEqual(res.payload.actionname, 'unittest/foo_func', 'Expect foo function');
            skillAgent.skills[0].properties = [{ name: 'model', value: 'bar' }];
            res = await skill.routeInput(activation, msg);
            assert.strictEqual(res.payload.actionname, 'unittest/bar_func', 'Expect bar function');
        });
    });
    describe('VERSION_ACTIONS is unset', () => {
        before(() => {
            config.runtime.actions.versionActions = undefined;
        });

        after(() => {
            importFresh('config');
        });

        it('routes to actions based on property', async () => {
            const channelId = 'foo';
            skillAgent.skills[0].properties = [{ name: 'model', value: 'foo' }];
            const skill = new Skill({ agent: skillAgent }, { ref: skillAgent.skills[0] }, skillPropRoute, synapseMock, SecretClientMock);
            const activation = {
                projectId,
                sessionId,
                processors: 'bar',
                processorName: 'baz',
                inputName: 'text',
                input: skillPropRoute.inputs[0],
                channelId,
            };
            const msg = {
                channelId,
                projectId,
                sessionId,
                token,
                payload: { text: 'test123' },
            };
            skillAgent.skills[0].properties = [{ name: 'model', value: 'bogo_val' }];
            let res = await skill.routeInput(activation, msg);
            assert.strictEqual(res.payload.actionname, 'unittest/default_func', 'Expect default function');
            skillAgent.skills[0].properties = [{ name: 'model', value: 'foo' }];
            res = await skill.routeInput(activation, msg);
            assert.strictEqual(res.payload.actionname, 'unittest/foo_func', 'Expect foo function');
            skillAgent.skills[0].properties = [{ name: 'model', value: 'bar' }];
            res = await skill.routeInput(activation, msg);
            assert.strictEqual(res.payload.actionname, 'unittest/bar_func', 'Expect bar function');
        });
    });
});
