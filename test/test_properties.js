import _ from 'lodash';
import assert from 'assert';
import { Skill } from '../lib/skill.ts';
import { mockLogger } from './testutil/index.js';
import mappingFn from '../lib/mapping.js';

const logger = mockLogger(false);
const projectId = 'propTestProj';
const skillDef = {
    camel: '1.0.0',
    name: 'skill/props',
    properties: [
        {
            name: 'prop1',
            defaultValue: 'prop1 default value skill def',
            type: 'string',
        },
        {
            name: 'prop2',
            defaultValue: 'prop2 default value skill def',
            type: 'string',
        },
        {
            name: 'secretprop1',
            // eslint-disable-next-line no-template-curly-in-string
            defaultValue: '${secure.skilldefprop1}',
            type: 'string',
        },
        {
            name: 'secretprop2',
            // eslint-disable-next-line no-template-curly-in-string
            defaultValue: '#SECURE.skilldefprop2',
            type: 'string',
        },
    ],
};
const agentDef = {
    camnel: '1.0.0',
    name: 'agent/withprops',
    properties: [
        { name: 'prop1', value: 'agent definition prop1 value' },
    ],
    skills: [
        {
            skillName: 'skill/NOprops',
            title: 'user props from agent def',
            refId: '476f60c1-125e-4e92-978c-9c6cce3b30e7',
        },
        {
            skillName: 'skill/props',
            title: 'user props from skill ref',
            refId: '476f60c1-125e-4e92-978c-9c6cce3b30e7',
            properties: [
                {
                    name: 'prop1',
                    value: 'skill reference prop1 value',
                },
            ],
        },
        {
            skillName: 'skill/props',
            title: 'user props from skill ref',
            refId: '476f60c1-125e-4e92-978c-9c6cce3b30e7',
        },
        {
            skillName: 'skill/extraprops',
            title: 'user props from skill ref',
            refId: '476f60c1-125e-4e92-978c-9c6cce3b30e7',
            properties: [
                {
                    name: 'extraprop1',
                    value: 'Shouldn\'t see me I am extra',
                },
            ],
        },
    ],
};
const secretMock = {
    getSecrets: async (proj, vars) => vars.map((s) => `secret ${proj}:${s}`),
};
let mapping;
describe('test properties', () => {
    before(async () => {
        mapping = mappingFn({ redis: {} });
    });
    it('prop1 from agent definition', async () => {
        const newsSkillDef = _.set(skillDef, { name: 'skill/NOprops' });
        // Planner does this ..
        const res = mapping.mergeProperties(agentDef, agentDef.skills[0]);
        const skillSpec = {
            ref: {
                ...agentDef.skills[0],
                properties: res,
            },
        };
        const skill = new Skill(agentDef.name, skillSpec, newsSkillDef, { logger }, secretMock);
        const props = await skill.getProperties(projectId);
        assert.strictEqual(props.prop1, 'agent definition prop1 value', 'Expect property from agent definition');
    });
    it('prop1 from skill reference', async () => {
        const skillSpec = {
            ref: agentDef.skills[1],
        };
        const skill = new Skill(agentDef.name, skillSpec, skillDef, { logger }, secretMock);
        const props = await skill.getProperties(projectId);
        assert.strictEqual(props.prop1, 'skill reference prop1 value', 'Expect property from skill reference efinition');
    });
    it('prop1 from skill definition', async () => {
        const skillSpec = {
            ref: agentDef.skills[1],
        };
        const skill = new Skill(agentDef.name, skillSpec, skillDef, { logger }, secretMock);
        const props = await skill.getProperties(projectId);
        assert.strictEqual(props.prop2, 'prop2 default value skill def', 'Expect property from agent definition');
    });
    it('secretprop1 and secretprop2 from skill definition', async () => {
        const skillSpec = {
            ref: agentDef.skills[2],
        };
        const skill = new Skill(agentDef.name, skillSpec, skillDef, { logger }, secretMock);
        const props = await skill.getProperties(projectId);
        assert.strictEqual(props.secretprop1, `secret ${projectId}:skilldefprop1`, 'Expect secret from skill definition');
        assert.strictEqual(props.secretprop2, `secret ${projectId}:skilldefprop2`, 'Expect secret from skill definition');
    });
    it('ignore property not defined in skill definition', async () => {
        const skillSpec = {
            ref: agentDef.skills[3],
        };
        const skill = new Skill(agentDef.name, skillSpec, skillDef, { logger }, secretMock);
        const props = await skill.getProperties(projectId);
        assert.strictEqual(props.extraprop1, undefined, 'Expect undefined for property not defined in  skill definition');
    });
});
