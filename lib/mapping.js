import Joi from 'joi';
import _ from 'lodash';
import { badRequest, notFound } from '@hapi/boom';
import { sanitizeName } from '@tt-sensa/sensa-express-common/k8s.js';
import sessions from './controllers/sessions.js';

export default (infra) => {
    const resourceProvider = infra.resourceProvider;
    const sessionCtrl = sessions(infra);
    const mappingRuleSchema = Joi.object({
        source: Joi.object({
            parameter: Joi.string(),
            manual: Joi.any(),
            sessionKey: Joi.string(),
        })
            .required()
            .xor('parameter', 'manual', 'sessionKey'),
        target: Joi.object({
            parameter: Joi.string()
                .required(),
        })
            .required(),
    });
    const mappingsSchema = Joi.array()
        .items(mappingRuleSchema);
    /**
     * Validate mappings need to avoid adding this overhead to invoke.
     * @param mappings
     * @returns {*} - null if valid, errors if notFg
     */
    function validateMapping(mappings) {
        return mappingsSchema.validate(mappings);
    }
    /**
     * Merge properties by 'name'
     * @param agent
     * @param ref
     * @return {unknown[]}
     */
    function mergeProperties(agent, ref) {
        return _.unionBy(agent.properties || [], ref.properties || [], 'name');
    }
    /**
     * @param projectId
     * @param sessionId
     * @param input
     * @param mappings
     * @returns {*} - result of mapping
     */
    async function executeMapping(projectId, sessionId, input, mappings) {
        const res = {};
        let sessionData = {};
        // if I have a sessionKey grab the data once.
        if (mappings.filter((m) => _.has(m, 'source.sessionKey')).length > 0) {
            sessionData = await sessionCtrl.getSession(projectId, sessionId);
        }
        mappings.forEach((m) => {
            let val;
            if (_.has(m, 'source.parameter')) val = input?.[m.source.parameter];
            else if (_.has(m, 'source.manual')) val = m.source.manual;
            else if (_.has(m, 'source.sessionKey')) val = sessionData?.[m.source.sessionKey];
            _.set(res, m.target.parameter, val);
        });
        return res;
    }
    // Get resource provider, so we can get information about skills
    const getSkillByRef = (agent, refId) => agent.skills.find((s) => refId === s.refId);
    const getOutputById = (agent, signalId) => agent.outputs.find((s) => signalId === s.signalId);
    /**
     * Analyze the skill and return an object with skill info
     * Initially just synchronous or asynchronous
     * @param project
     * @param skillName
     * @return {Promise<{synchronous: *}|{synchronous: boolean}>}
     */
    async function checkSkill(project, skillName, inputName = undefined) {
        const skill = await resourceProvider.getSkill(project, skillName);
        if (!skill) {
            throw badRequest(`Unable to find skill ${project}.${skillName}, verify it is deployed to the cluster`);
        }
        const inputs = inputName ? skill.inputs.filter((i) => i.name === inputName) : skill.inputs;
        const routes = _.compact(_.flatten(inputs.map((i) => {
            const ar = i?.routing?.all;
            const dr = i?.routing?.default;
            const rrs = i?.routing?.rules ?? [];
            return [ar, dr, ...rrs];
        }))).filter((r) => !_.isEmpty(r));  // remove empty routes
        const syncs = routes.map((a) => {
            // TODO move to runtimes ..
            if (a?.runtime?.toLowerCase() === 'cortex/system') {
                return {
                    agentInvoke: false,
                    script: true,
                    merge: true,
                }[a.action];
            }
            if (['cortex/external-api', 'cortex/test-daemon'].includes(a?.runtime?.toLowerCase())) {
                return true;
            }
            if (!skill.actions) {
                return false;
            }
            // actions name may be lowercase, use case-insensitive comparison
            const actionName = sanitizeName(a.action);
            const action = skill.actions.find((act) => sanitizeName(act.name) === actionName);
            if (!action) {
                throw badRequest(`Skill ${project}.${skillName} is missing action ${a.action}`);
            }
            return action?.type?.toLowerCase() === 'daemon';
        });
        return { synchronous: syncs.every((b) => b === true) };
    }
    function findPaths(agent, id, targetId, currPath = [], pathsFound = [], nodes = {}) {
        // 1) find and visit next nodes
        const res = agent.mappings.filter((m) => id === m?.from?.input?.signalId || id === m?.from?.skill?.refId);
        if (_.isEmpty(res)) {
            // TODO validate if no mapping is permissible
            const node = nodes[id];
            throw badRequest(`No mapping from ${node?.type} ${node?.name} (${id}) in agent ${agent.name}`);
        }
        res.forEach((n) => {
            const nextId = n?.to?.skill?.refId;
            if (nextId) {
                // 2) check for cycles, have I visited this path segment before?
                if (currPath.some((i) => i[0] === id && i[1] === nextId)) {
                    // A skill refId can only exist once in a path from agent input -> output otherwise assume a cycle.
                    throw new Error(`Cycle detected at skill "${getSkillByRef(agent, id)?.skillName}" refId "${id}"`);
                }
                const skillRef = getSkillByRef(agent, nextId);
                if (!skillRef) {
                    throw badRequest(`Invalid agent definition, missing skill reference "${nextId}"`);
                }
                //  These are all nodes visited, so extra nodes need to be pruned later...
                nodes[nextId] = {
                    type: 'skill',
                    title: skillRef.title,
                    name: skillRef.skillName,
                };
                // 3) store visit
                // 4) process next child in tree.
                findPaths(agent, nextId, targetId, [...currPath, [id, nextId, n]], pathsFound, nodes);
            } else {
                // If no next skill, check output
                const outId = n?.to?.output?.signalId;
                // if check target reach store path, otherwise skip (prune)
                if (outId === targetId) {
                    pathsFound.push([...currPath, [id, outId, n]]);
                    // Add mode so gateway knows how to treat this output.
                    const output = getOutputById(agent, outId);
                    nodes[outId] = {
                        type: 'output',
                        name: output.name,
                        title: output.title,
                        mode: output?.mode ?? 'single',
                    };
                }
            }
        });
    }

    function updateMergeSKillProps(states, pathSegs) {
        // This will contain multiples for each call to a skill, need to update them all.
        const mergeSkillRefs = states.filter((s) => s?.ref?.skillName === 'merge');
        mergeSkillRefs.forEach((r) => {
            const cnt = pathSegs.filter((p) => p[1] === r.to).length;
            const mergeProp = (r?.ref?.properties ?? []).find((p) => p.name === 'items');
            // If I don't find `items` property use computed value
            if (!mergeProp) {
                if (!r.ref.properties) {
                    r.ref.properties = [];
                }
                r.ref.properties.push({
                    name: 'items',
                    value: cnt,
                });
            }
        });
    }
    // Process the pathSegments and check skills, gather some useful runtime data.
    async function getPlanV2(projectId, agent, pathSegments, nodes, states) {
        await pathSegments.reduce(async (prev, [from, , ref]) => {
            await prev;
            const skillRefId = ref?.to?.skill?.refId;
            const fromOutput = ref?.from?.skill?.output ?? '';
            if (_.isEmpty(skillRefId)) {
                // output
                const signalId = ref?.to?.output?.signalId;
                const output = getOutputById(agent, signalId);
                if (_.isEmpty(output)) {
                    // Get some details for a better message
                    const fromSkillRefId = ref?.from?.skill?.refId;
                    const fromSkillOutput = ref?.from?.skill?.output;
                    const skillRef = getSkillByRef(agent, fromSkillRefId);
                    throw badRequest(`Error skill "${skillRef.title || ''}" (${skillRef.skillName}) output "${fromSkillOutput}" in agent ${projectId}.${agent.name}, is mapped to an invalid agent output`);
                }
                const existingState = states.filter((s) => s.from === from && s.to === signalId && s.fromOutput === fromOutput);
                // Should only have ONE route from a give skill to output + skill output
                if (_.isEmpty(existingState)) {
                    states.push({
                        synchronous: true,
                        from,
                        to: signalId,
                        fromOutput,
                        toInput: output.name,
                        type: 'output',
                        ref: output,
                        mapping: ref?.rules ?? [],
                    });
                }
            } else {
                // skill
                const skillRef = getSkillByRef(agent, skillRefId);
                if (!skillRef) {
                    throw new Error(`No SkillRef found for skillRef ${skillRefId}`);
                }
                // Should only have ONE route from skill to downstream skill + skill output
                if (_.find(states, (s) => s.from === from && s.to === skillRefId && s.fromOutput === fromOutput) === undefined) {
                    const nref = {
                        ...skillRef,
                        properties: mergeProperties(agent, skillRef),
                    };
                    const { synchronous } = await checkSkill(projectId, nref.skillName, ref.to.skill.input);
                    states.push({
                        synchronous,
                        from,
                        to: skillRefId,
                        fromOutput,
                        toInput: ref.to.skill.input,
                        type: 'skill',
                        ref: nref,
                        mapping: ref?.rules ?? [],
                    });
                }
            }
        }, Promise.resolve());
    }
    function trimNodes(paths, nodes) {
        const nodeRefs = [...new Set(paths.map((n) => [n[0], n[1]]).flat())];
        return _.pick(nodes, nodeRefs);
    }
    /**
     * Create a list of processing steps for a given agent's input
     *
     * @param {*} agent - the agent definition
     * @param {string} inputName - the agent input name
     * @return {object}  nodes, states: { from: "id", to: "id", fromOutput: "name", toInput: "name", mapping: [], ref: {skillRef|output}, type: "skill|output" }, input
     */
    async function genPlan(projectId, agent, inputName) {
        let nodes = {};
        const states = [];
        const input = (agent?.inputs ?? []).find((i) => inputName === i.name);
        if ((agent?.mappings ?? []).length === 0 ) {
            throw badRequest(`Agent ${agent?.name ?? '<NO NAME>'} is invalid: no mappings are defined in the agent`);
        }
        if (_.isEmpty(input)) {
            throw badRequest(`Input "${inputName}" not found in agent ${agent.name}`);
        }
        const output = (agent.outputs || []).find((o) => input.output === o.name);
        if (!output) {
            throw badRequest(`Output with name "${input.output}" for input "${inputName}" not found in agent "${agent.name}"`);
        }
        nodes[input.signalId] = {
            type: 'input',
            name: input.name,
        };
        // Generate all paths from input to ouput, navigating depth first, remove path going to wrong output
        const paths = [];
        findPaths(agent, input.signalId, output.signalId, [], paths, nodes); // << returns ALL nodes visited, prune extras
        if (_.isEmpty(paths)) {
            throw badRequest(`Invalid agent mapping no paths found from "${inputName}" to output "${input.output}"`);
        }
        // Check skills and get merge-skill connection count(s) here.
        const pathSegments = _.flatten(paths);
        // There should ONLY ever be a single from-to pair for each skill, so flatten paths and de-dup segments
        const uniqPathSegments = _.uniq(pathSegments);
        // Prune extra nodes, that I don't see in the paths
        nodes = trimNodes(uniqPathSegments, nodes);
        // This just remaps the segments + refs into
        await getPlanV2(projectId, agent, uniqPathSegments, nodes, states, []);
        updateMergeSKillProps(states, pathSegments); // update merge skill's skillrefs properties with computed item count
        // If all states are synchronous then agent is synchronous capable..
        const synchronous = Object.values(states)
            .every((n) => n.synchronous);
        return {
            agentName: agent.name,
            agentTitle: agent.title,
            projectId,
            serviceName: inputName,
            synchronous,
            nodes,
            states,
            input,
            output,
        };
    }
    /**
     * Return cached plan or compute a new one for agent + input
     * @param projectId
     * @param agentName
     * @param inputName
     * @param nocache
     * @return {Promise<plan>}
     */
    async function getPlan(projectId, agentName, inputName, nocache = false) {
        const planId = `${projectId}-${agentName}-${inputName}`;
        const cachedPlan = await resourceProvider.getPlan(planId);
        if (!nocache && cachedPlan) {
            return cachedPlan;
        }
        const agent = await resourceProvider.getAgent(projectId, agentName);
        if (!agent) {
            throw notFound(`Agent "${agentName}" not found in project ${projectId}`);
        }
        const newPlan = await genPlan(projectId, agent, inputName);
        resourceProvider.putPlan(planId, newPlan);
        return newPlan;
    }
    function diagramForPlan(plan) {
        const lines = [];
        const linesDiag = {
            input: (c) => lines.push(`"${c}" [label=" ", color=black, shape=circle, fixedsize="5x5", style=filled];`),
            output: (c) => lines.push(`"${c}" [label=" ", color=black, shape=doublecircle, fixedsize="5x5", style=filled];`),
            skill: (c, node) => lines.push(`"${c}" [label="${node.title}\n(${node.name})"color=blue, shape=oval];`),
        };
        Object.keys(plan.nodes)
            .forEach((channelId) => {
            const node = plan.nodes[channelId];
            linesDiag[node.type](channelId, node);
        });
        plan.states.forEach((s) => {
            lines.push(`"${s.from}" -> "${s.to}" [labelfloat=true, taillabel="${s.fromOutput}", headlabel="${s.toInput}"]`);
        });
        return lines;
    }
    return {
        validateMapping,
        executeMapping,
        genPlan,
        getPlan,
        checkSkill,
        diagramForPlan,
        mergeProperties,
    };
};
