import _ from 'lodash';
import config from 'config';
import fs from 'fs';
import chai from 'chai';
import assert from 'assert';
import nock from 'nock';
import Redis from 'ioredis';
import { getResourceProvider } from '../lib/clients/resources.js';
import mappingFn from '../lib/mapping.js';
import { nativeOmit } from '../lib/utils.js';

let redisClient;
let mapping;
const { expect } = chai;
// Test data
const sessionId = 'sessionId';
const projectId = 'cogscale';
const sourceData = {
    astr: 'aaa', bstr: 'bbb', cnum: 10, dbool: false, earry: ['a', 'b', 'c'], fobj: { just: 'in case' },
};

// (await prom).Should.throw(Error) didn't allow message check :(
const checkError = async (prom, errorMessage) => {
    let error = null;
    try {
        await prom;
    } catch (err) {
        error = err;
        if (errorMessage) {
            expect(error?.message).to.equal(errorMessage);
        }
    }
    expect(error).to.be.an('Error');
};
const mappings = [
    { source: { parameter: 'astr' }, target: { parameter: 'newastr' } },
    { source: { parameter: 'bstr' }, target: { parameter: 'newbstr' } },
    { source: { parameter: 'cnum' }, target: { parameter: 'newcnum' } },
    { source: { parameter: 'dbool' }, target: { parameter: 'newdbool' } },
    { source: { parameter: 'earry' }, target: { parameter: 'newearry' } },
    { source: { parameter: 'fobj' }, target: { parameter: 'newfobj' } },
    { source: { manual: 'sesskey1' }, target: { parameter: 'manStr' } },
    { source: { manual: false }, target: { parameter: 'manBool' } },
    { source: { manual: 1.999 }, target: { parameter: 'manNum' } },
    { source: { manual: [1, 2, 3] }, target: { parameter: 'manArray' } },
    { source: { sessionKey: 'sesskey1' }, target: { parameter: 'sessKey' } },
];
// input dataset ref DEPRECATED
const mappingsDataSet = [
    { from: { skill: { dataset: { refName: 'refD1' } } }, to: { skill: { refId: 'refS1' } } },
    { from: { skill: { refId: 'refS1' } }, to: { output: { signalId: 'refO1' } } },
];
// simple skill
const mappingsSingleSkill = [
    { from: { input: { signalId: 'refI1' } }, to: { skill: { refId: 'refS1' } } },
    { from: { skill: { refId: 'refS1' } }, to: { output: { signalId: 'refO1' } } },
];
// simple skill with no output
const mappingsSkillOutput = [
    { from: { input: { signalId: 'refI1' } }, to: { skill: { refId: 'refS1' } } },
];
// chained skills
const mappingsChain = [
    { from: { input: { signalId: 'refI1' } }, to: { skill: { refId: 'refS1', input: 'inputS1' } } },
    { from: { skill: { refId: 'refS1', output: 'outputS1' } }, to: { skill: { refId: 'refS2', input: 'inputS2' } } },
    { from: { skill: { refId: 'refS2', output: 'outputS2' } }, to: { skill: { refId: 'refS3', input: 'inputS3' } } },
    { from: { skill: { refId: 'refS3', output: 'outputS3' } }, to: { skill: { refId: 'refS4', input: 'inputS4' } } },
    { from: { skill: { refId: 'refS4', output: 'outputS4' } }, to: { output: { signalId: 'refO1' } } },
];
// branched skills, multiple different outputs ?? seem not good we drpo refO2 output ...
const mappingsBranch = [
    { from: { input: { signalId: 'refI1' } }, to: { skill: { refId: 'refS1' } } },
    { from: { skill: { refId: 'refS1' } }, to: { skill: { refId: 'refS2' } } },
    { from: { skill: { refId: 'refS1' } }, to: { skill: { refId: 'refS3' } } },
    { from: { skill: { refId: 'refS2' } }, to: { output: { signalId: 'refO1' } } },
    { from: { skill: { refId: 'refS3' } }, to: { output: { signalId: 'refO2' } } },
];
// chained skills with outputs
const mappingsmergeoutput = [
    { from: { input: { signalId: 'refI1' } }, to: { skill: { refId: 'refS1', input: 'inputS1' } } },
    { from: { skill: { refId: 'refS1' } }, to: { skill: { refId: 'refS2', input: 'inputS2' } } },
    { from: { skill: { refId: 'refS2' } }, to: { skill: { refId: 'refS3', input: 'inputS3' } } },
    { from: { skill: { refId: 'refS1' } }, to: { output: { signalId: 'refO1' } } },
    { from: { skill: { refId: 'refS3' } }, to: { output: { signalId: 'refO1' } } },
];
const skills = [
    { skillName: 'daemonGood', refId: 'refS1' },
    { skillName: 'daemonGood', refId: 'refS2' },
    { skillName: 'daemonGood', refId: 'refS3' },
    { skillName: 'daemonGood', refId: 'refS4' },
];
const PROJECT = 'cogscale';
const CORTEX_API = 'http://localhost:8888';
describe('test mappings', () => {
    before(async () => {
        try {
            redisClient = new Redis(config.redis.uri);
            // Plan generation now uses the resourceProvider to get skill defn
            const resourceProvider = await getResourceProvider();
            mapping = await mappingFn({ redis: redisClient, logger: undefined, resourceProvider });
        } catch (e) {
            console.error(`Error connecting to admin database, shutting down:${e}`);
            process.exit(1);
        }
    });
    after(async () => {
        await redisClient.disconnect();
    });
    describe('skill mappings', () => {
        it('validate mapping', (done) => {
            const res = mapping.validateMapping(mappings);
            assert(!res?.error, 'after good message error should be null');
            done();
        });
        it('invalid mapping', (done) => {
            // Clone mapping
            const mappingBad = _.cloneDeep(mappings);
            mappingBad[0] = Object.assign(mappingBad[0], { source: { foo: 'bar' } });
            const res1 = mapping.validateMapping(mappingBad);
            assert.ok(res1.error != null, 'add bogus key error should NOT be null');
            mappingBad[0] = Object.assign(mappingBad[0], {
                source: {
                    parameter: 'bar',
                    manual: 'nope',
                },
            });
            const res2 = mapping.validateMapping(mappingBad);
            assert.ok(res2.error != null, 'more than one key message error should NOT be null');
            done();
        });
        it('execute mapping with all keys', async () => {
            await redisClient.hset(`${projectId}.${sessionId}`, 'sesskey1', 'sesskey1Value');
            const res = await mapping.executeMapping(projectId, sessionId, sourceData, mappings);
            // All targets shold be present.
            mappings.forEach((m) => {
                assert.ok(_.has(res, m.target.parameter), `Mapping missing ${m.target.parameter}`);
            });
            // Make sure we don't stringify things
            assert.ok(_.isString(res.newastr), `expect newastr string ${res.newastr}`);
            assert.ok(_.isString(res.newbstr), 'expect newbstr string');
            assert.ok(_.isNumber(res.newcnum), 'expect newcnum number');
            assert.ok(_.isBoolean(res.newdbool), 'expect newdbool bool');
            assert.ok(_.isArray(res.newearry), 'expect newearry array');
            assert.ok(_.isPlainObject(res.newfobj), 'expect newfobj plain obj');
            assert.ok(_.isString(res.manStr), 'expect manStr string');
            assert.ok(_.isBoolean(res.manBool), 'expect manBool bool');
            assert.ok(_.isNumber(res.manNum), 'expect manNum num');
            assert.ok(_.isString(res.sessKey), 'expect sessKey string');
            return res;
        });
        it('execute mapping with missing bstr & dbool keys', async () => {
            nock(CORTEX_API)
                .get(`/fabric/v4/projects/${projectId}/sessions/sessionId`)
                .reply(200, { sesskey1: 'sesskey1Value' });
            const sourceDataMissingBD = nativeOmit(sourceData, 'bstr', 'dbool');
            const res = await mapping.executeMapping(projectId, sessionId, sourceDataMissingBD, mappings);
            // For assume we always have ALL targets in mapping missing values are undefined
            mappings.forEach((m) => {
                assert.ok(_.has(res, m.target.parameter), `Mapping missing ${m.target.parameter}`);
            });
            // Make sure we don't stringify things
            assert.ok(_.isString(res.newastr), 'expect newastr string');
            assert.ok(_.isNumber(res.newcnum), 'expect newcnum number');
            assert.ok(_.isArray(res.newearry), 'expect newearry array');
            assert.ok(_.isPlainObject(res.newfobj), 'expect newfobj plain obj');
            assert.ok(_.isString(res.manStr), 'expect manStr string');
            assert.ok(_.isBoolean(res.manBool), 'expect manBool bool');
            assert.ok(_.isNumber(res.manNum), 'expect manNum num');
            assert.ok(_.isString(res.sessKey), 'expect sessKey string');
            // assuming missing values are returned as undefined..
            assert.ok(_.isUndefined(res.newb), 'newb should be undefined');
            assert.ok(_.isUndefined(res.newd), 'newd should be undefined');
            return res;
        });
    });
    describe('test genPlan', async () => {
        it('returns an empty list for input dataset ref', async () => {
            // TODO dataset ref specific error ?
            await checkError(mapping.genPlan(PROJECT, {
                name: 'dsref',
                mappings: mappingsDataSet,
                skills,
            }, 'refD1'), 'Input "refD1" not found in agent dsref');
        });
        it('returns an empty list if there is no match', async () => {
            await checkError(mapping.genPlan(PROJECT, {
                name: 'nomatch',
                mappings: mappingsDataSet,
                skills,
                inputs: [{ name: 'input', signalId: 'refI1', output: 'output' }],
                outputs: [{ name: 'output', signalId: 'refO1' }],
            }, 'input'), 'No mapping from input input (refI1) in agent nomatch');
        });
        it('single skill', async () => {
            const single = {
                name: 'singleskill',
                mappings: mappingsSingleSkill,
                skills,
                inputs: [{ name: 'input', signalId: 'refI1', output: 'output' }],
                outputs: [{ name: 'output', signalId: 'refO1' }],
            };
            const plan = await mapping.genPlan(PROJECT, single, 'input');
            expect(plan).to.have.property('states').length(2);
            expect(plan.states.find((s) => s.type === 'output')).to.have.property('from', 'refS1');
            expect(plan.states.find((s) => s.type === 'output')).to.have.property('to', 'refO1');
            // Expect plan to include agent metadata (title is optional)
            expect(plan.agentName).to.equal(single.name);
            expect(plan).to.have.property('agentTitle');
            // eslint-disable-next-line no-unused-expressions, @typescript-eslint/no-unused-expressions
            expect(plan.agentTitle).to.be.undefined; // TODO: not sure about this
        });
        it('single skill no action', async () => {
            await checkError(mapping.genPlan(PROJECT, {
                name: 'singleskill',
                mappings: [
                    { from: { input: { signalId: 'refI1' } }, to: { skill: { refId: 'refMA' } } },
                    { from: { skill: { refId: 'refMA' } }, to: { output: { signalId: 'refO1' } } },
                ],
                skills: [{ skillName: 'missing-action', refId: 'refMA' }],
                inputs: [{ name: 'input', signalId: 'refI1', output: 'output' }],
                outputs: [{ name: 'output', signalId: 'refO1' }],
            }, 'input'), 'Skill cogscale.missing-action is missing action not-here');
        });
        it('bad mapping skillId', async () => {
            const agent = {
                name: 'singleskill',
                mappings: mappingsSkillOutput,
                skills,
                inputs: [{ name: 'input', signalId: 'refI1', output: 'output' }],
                outputs: [{ name: 'output', signalId: 'refO1' }],
            };
            await checkError(mapping.genPlan(PROJECT, _.set(_.cloneDeep(agent), 'skills[0].refId', 'nothere'), 'input'), 'Invalid agent definition, missing skill reference "refS1"');
        });
        it('no mappings error', async () => {
            const agent = {
                name: 'singleskill',
                mappings: [],
                skills,
                inputs: [{ name: 'input', signalId: 'refI1', output: 'output' }],
                outputs: [{ name: 'output', signalId: 'refO1' }],
            };
            await checkError(mapping.genPlan(PROJECT, agent, 'input'), 'Agent singleskill is invalid: no mappings are defined in the agent');
        });
        it('chained skill x 4', async () => {
            const chainSkill = {
                name: 'chainskill',
                mappings: mappingsChain,
                skills,
                inputs: [{ name: 'input', signalId: 'refI1', output: 'output' }],
                outputs: [{ name: 'output', signalId: 'refO1' }],
            };
            const plan = await mapping.genPlan(PROJECT, chainSkill, 'input');
            expect(plan).to.have.property('states').length(5);
            expect(plan.states.filter((s) => s.type === 'skill')).to.have.length(4);
            expect(plan.states.find((s) => s.type === 'output')).to.have.property('from', 'refS4');
            // Expect plan to include agent metadata (title is optional)
            expect(plan.agentName).to.equal(chainSkill.name);
            expect(plan).to.have.property('agentTitle');
            // eslint-disable-next-line no-unused-expressions, @typescript-eslint/no-unused-expressions
            expect(plan.agentTitle).to.be.undefined;
        });
        it('returns two skills skill on branch', async () => {
            const chainSkill = {
                name: 'chainskill',
                mappings: mappingsBranch,
                skills,
                inputs: [{ name: 'input', signalId: 'refI1', output: 'output' }],
                outputs: [
                    { name: 'output', signalId: 'refO1' },
                    { name: 'output2', signalId: 'refO2' },
                ],
            };
            const plan = await mapping.genPlan(PROJECT, chainSkill, 'input');
            expect(plan).to.have.property('states').length(3); // don't expect O2 & S3
            expect(plan.states.filter((s) => s.type === 'skill')).to.have.length(2); // Expect S1 & s2;
            expect(plan.states.filter((s) => s.type === 'output')).to.have.length(1); // only 1` output ever
            expect(plan.states.find((s) => s.from === 'refS2')).to.have.property('to', 'refO1');
            // Expect plan to include agent metadata (title is optional)
            expect(plan.agentName).to.equal(chainSkill.name);
            expect(plan).to.have.property('agentTitle');
            // eslint-disable-next-line no-unused-expressions, @typescript-eslint/no-unused-expressions
            expect(plan.agentTitle).to.be.undefined;
        });
        it('does not shortcut if there are more skills to process', async () => {
            const chainSkill = {
                name: 'chainskill',
                mappings: mappingsmergeoutput,
                skills,
                inputs: [{ name: 'input', signalId: 'refI1', output: 'output' }],
                outputs: [
                    { name: 'output', signalId: 'refO1' },
                    { name: 'output2', signalId: 'refO2' },
                ],
            };
            const plan = await mapping.genPlan(PROJECT, chainSkill, 'input');
            expect(plan).to.have.property('states').length(5);
            expect(plan.states.filter((s) => s.type === 'skill')).to.have.length(3);
            expect(plan.states.filter((s) => s.type === 'output')).to.have.length(2);
            expect(plan.states.find((s) => s.from === 'refS3' && s.type === 'output')).to.have.property('to', 'refO1');
            expect(plan.states.find((s) => s.from === 'refS1' && s.type === 'output')).to.have.property('to', 'refO1');
            // Expect plan to include agent metadata (title is optional)
            expect(plan.agentName).to.equal(chainSkill.name);
            expect(plan).to.have.property('agentTitle');
            // eslint-disable-next-line no-unused-expressions, @typescript-eslint/no-unused-expressions
            expect(plan.agentTitle).to.be.undefined;
        });
        it('plan with merge', async () => {
            const jsonData = fs.readFileSync('./test/data/agents/merge-test.json');
            const mergeTest = JSON.parse(jsonData);
            const plan = await mapping.genPlan(PROJECT, mergeTest, 'input');
            expect(plan).to.have.property('states').length(6);
            expect(plan.states.filter((s) => s.type === 'skill')).to.have.length(5);
            expect(plan.states.filter((s) => s.type === 'output')).to.have.length(1);
            expect(plan.states.find((s) => s.from === 'good-skill-last' && s.type === 'output')).to.have.property('to', 'agent-output');
            // one state out of merge, and down stream skills
            expect(plan.states.filter((s) => s.from === 'merge-skill')).to.have.length(1);
            expect(plan.states.filter((s) => s.from === 'good-skill-last')).to.have.length(1);
            // expect Agent name & title to be included in the plan
            expect(plan.agentName).to.equal(mergeTest.name);
            expect(plan.agentTitle).to.equal(mergeTest.title);
        });
        it('no output', async () => {
            await checkError(mapping.genPlan(PROJECT, {
                name: 'noutput',
                mappings: mappingsSkillOutput,
                skills,
                inputs: [{ name: 'input', signalId: 'refI1', output: 'output' }],
                outputs: [],
            }, 'input'), 'Output with name "output" for input "input" not found in agent "noutput"');
        });
        it('multiple inputs', async () => {
            const jsonData = fs.readFileSync('./test/data/agents/multiple-inputs.json');
            const agent = JSON.parse(jsonData);
            const planA = await mapping.genPlan(PROJECT, agent, 'a');
            const outputs = planA.states.filter((s) => s.type === 'output');
            const skillStates = planA.states.filter((s) => s.type === 'skill');
            expect(outputs).to.have.length(1);
            expect(skillStates).to.have.length(3);
            expect(outputs[0].ref).to.have.property('name').equal('a');
        });
        it('branch daemon', async () => {
            // input -> 2 skills -> output x2
            const agentName = 'branching';
            const expectedAgentTitle = 'input -> two daemons -> output';
            const resourceProvider = await getResourceProvider();
            const agentInst = await resourceProvider.getAgent(projectId, agentName);
            // Pretend we are passed channelId via a synapse message
            const { agentTitle, nodes, states } = await mapping.genPlan(PROJECT, agentInst, 'input');
            // console.log(`START -> "${channelId}"  [label="INPUT ${inputInst.name}"];`);
            // Expect all skills in agent (5), an input, and an output
            expect(Object.values(nodes).filter((s) => s.type === 'skill')).to.have.length(2);
            expect(Object.values(nodes).filter((s) => s.type === 'input')).to.have.length(1);
            expect(Object.values(nodes).filter((s) => s.type === 'output')).to.have.length(1);
            // Expect 6 transit to skills and 1 possible outputs
            expect(states.filter((s) => s.type === 'skill')).to.have.length(2);
            expect(states.filter((s) => s.type === 'output')).to.have.length(2);
            // Expect the plan to include the Agent title
            expect(agentTitle).to.equal(expectedAgentTitle);
        });
        it('multiple inputs sync input A', async () => {
            const agentName = 'multiple-input-sync';
            const expectedAgentTitle = 'Multiple input sync test';
            const resourceProvider = await getResourceProvider();
            const agentInst = await resourceProvider.getAgent(projectId, agentName);
            // Pretend we are passed channelId via a synapse message
            const { agentTitle, nodes, states } = await mapping.genPlan(PROJECT, agentInst, 'a');
            // console.log(`START -> "${channelId}"  [label="INPUT ${inputInst.name}"];`);
            // Expect all skills in agent (5), an input, and an output
            expect(Object.values(nodes)
                .filter((s) => s.type === 'skill'))
                .to
                .have
                .length(3);
            expect(Object.values(nodes)
                .filter((s) => s.type === 'input'))
                .to
                .have
                .length(1);
            expect(Object.values(nodes)
                .filter((s) => s.type === 'output'))
                .to
                .have
                .length(1);
            // Expect 6 transit to skills and 1 possible outputs
            expect(states.filter((s) => s.type === 'skill'))
                .to
                .have
                .length(3);
            expect(states.filter((s) => s.type === 'output'))
                .to
                .have
                .length(1);
            // Expect the plan to include the Agent title
            expect(agentTitle).to.equal(expectedAgentTitle);
        });
        it('multiple inputs sync input B', async () => {
            const agentName = 'multiple-input-sync';
            const expectedAgentTitle = 'Multiple input sync test';
            const resourceProvider = await getResourceProvider();
            const agentInst = await resourceProvider.getAgent(projectId, agentName);
            // Pretend we are passed channelId via a synapse message
            const { agentTitle, nodes, states } = await mapping.genPlan(PROJECT, agentInst, 'b');
            // console.log(`START -> "${channelId}"  [label="INPUT ${inputInst.name}"];`);
            // Expect all skills in agent (5), an input, and an output
            expect(Object.values(nodes)
                .filter((s) => s.type === 'skill'))
                .to
                .have
                .length(1);
            expect(Object.values(nodes)
                .filter((s) => s.type === 'input'))
                .to
                .have
                .length(1);
            expect(Object.values(nodes)
                .filter((s) => s.type === 'output'))
                .to
                .have
                .length(1);
            // Expect 6 transit to skills and 1 possible outputs
            expect(states.filter((s) => s.type === 'skill'))
                .to
                .have
                .length(1);
            expect(states.filter((s) => s.type === 'output'))
                .to
                .have
                .length(1);
            // Expect the plan to include the Agent title
            expect(agentTitle).to.equal(expectedAgentTitle);
        });
        it('generate plan detect agent with cycle', async () => {
            const agent = {
                camel: '1.0.0',
                name: 'agentinvoke',
                title: '',
                tags: [],
                inputs: [
                    {
                        signalType: 'Service',
                        name: 'input',
                        title: 'input',
                        signalId: 'input1',
                        parameters: [
                            {
                                name: 'text',
                                required: true,
                                title: 'text',
                                type: 'string',
                            },
                        ],
                        output: 'output',
                    },
                ],
                outputs: [
                    {
                        signalType: 'Service',
                        name: 'output',
                        title: 'output',
                        signalId: 'output1',
                        parameters: [
                            {
                                name: 'text',
                                required: true,
                                title: 'text',
                                type: 'string',
                            },
                        ],
                    },
                ],
                skills: [
                    {
                        properties: [],
                        skillName: 'good-skill',
                        refId: 'goodskill1',
                    },
                    {
                        properties: [],
                        skillName: 'agent-invoke',
                        refId: 'agent-invoke1',
                    },
                    {
                        properties: [],
                        skillName: 'good-skill',
                        refId: 'another-skill1',
                    },
                ],
                mappings: [
                    {
                        from: {
                            input: {
                                signalId: 'input1',
                            },
                        },
                        to: {
                            skill: {
                                refId: 'goodskill1',
                                input: 'input',
                            },
                        },
                        rules: [],
                    },
                    {
                        from: {
                            skill: {
                                refId: 'goodskill1',
                                output: 'output',
                            },
                        },
                        to: {
                            skill: {
                                refId: 'agent-invoke1',
                                input: 'input',
                            },
                        },
                        rules: [],
                    },
                    {
                        from: {
                            skill: {
                                refId: 'agent-invoke1',
                                output: 'output',
                            },
                        },
                        to: {
                            skill: {
                                refId: 'another-skill1',
                                input: 'input',
                            },
                        },
                        rules: [],
                    },
                    {
                        from: {
                            skill: {
                                refId: 'another-skill1',
                                output: 'output',
                            },
                        },
                        to: {
                            skill: {
                                refId: 'goodskill1',
                                input: 'input',
                            },
                        },
                        rules: [],
                    },
                    {
                        from: {
                            skill: {
                                refId: 'another-skill1',
                                output: 'output',
                            },
                        },
                        to: {
                            output: {
                                signalId: 'output1',
                            },
                        },
                        rules: [],
                    },
                ],
            };
            await checkError(mapping.genPlan(PROJECT, agent, 'input'), 'Cycle detected at skill "good-skill" refId "goodskill1"');
        });
        it('dex core agent plan 11 skills, branches, merges oh my..', async () => {
            const jsonData = fs.readFileSync('./test/data/agent-dex-core.json');
            const agent = JSON.parse(jsonData);
            const plan = await mapping.genPlan(PROJECT, agent, 'predict');
            expect(plan).to.have.property('states').length(17);
            // More of a test to see if it throws exceptions, false positive on cycles
        });
        it('no output v2', async () => {
            await checkError(mapping.genPlan(PROJECT, {
                name: 'chainskill',
                mappings: mappingsChain.slice(0, -1),
                skills,
                inputs: [{
                        name: 'input',
                        signalId: 'refI1',
                        output: 'output',
                    }],
                outputs: [{
                        name: 'output',
                        signalId: 'refO1',
                    }],
            }, 'input'), 'No mapping from skill daemonGood (refS4) in agent chainskill');
        });
        it('Bad input refId', async () => {
            await checkError(mapping.genPlan(PROJECT, {
                name: 'chainskill',
                mappings: mappingsChain,
                skills,
                inputs: [{
                        name: 'input',
                        // bad refId
                        signalId: 'NOTHERE',
                        output: 'output',
                    }],
                outputs: [{
                        name: 'output',
                        signalId: 'refO1',
                    }],
            }, 'input'), 'No mapping from input input (NOTHERE) in agent chainskill');
        });
        it('Missing output', async () => {
            await checkError(mapping.genPlan(PROJECT, {
                name: 'chainskill',
                mappings: mappingsChain,
                skills,
                inputs: [{
                        name: 'input',
                        signalId: 'refI1',
                        output: 'output',
                    }],
                outputs: [{
                        name: 'output',
                        signalId: 'NOTHERE',
                    }],
            }, 'input'), 'Invalid agent mapping no paths found from "input" to output "output"');
        });
        // TODO test short-circuit
    });
});
