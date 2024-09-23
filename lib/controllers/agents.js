import _ from 'lodash';
import config from 'config';
// eslint-disable-next-line import/no-unresolved
import got from 'got';
import {
    sendResponse, toBoolean, parseJwt, validateOptions, sendTsoaResponse,
} from '@tt-sensa/sensa-express-common';
import { QualifiedName } from '@tt-sensa/sensa-admin-db';
import { v4 as uuid } from 'uuid';
import * as boom from '@hapi/boom';
import { K8SRESOURCES, getNamespace, tok8sName } from '@tt-sensa/sensa-express-common/k8s.js';
import * as ctx from '@tt-sensa/sensa-express-common/express-context.js';
import { CANCELLED, COMPLETE, ERROR, PENDING } from '../state/abstractStateStore.js';
import { subscribeToAgentEvents as socketListener } from '../events/socketEventListener.js';
import WebSocketEventHandler from '../events/socketEventHandler.js';
import { createK8sTask, validateCron } from '../actions/taskUtils.js';
import { InputMessage } from '../actions/messages.js';
import { SynapseMessage } from '../models/synapseMessage.js';
import { nativeOmit, parseJson } from '../utils.js';

const SHARED_PROJECT = config.resources.shareProject;

export default (infra, synapse, taskCtrl) => {
    const { logger } = infra;
    async function listActivations(projectId, query) {
        let activations = [];
        let filter = {};
        try {
            filter = parseJson(query?.filter ?? {});
        } catch (err) {
            throw boom.badRequest('Invalid query params', { details: 'filter must be a valid JSON string' });
        }
        if (typeof query?.sort?.valueOf() === 'string') {
            if (query?.sort?.toLowerCase() === 'asc') {
                query.sort = { start: 1 };

            } else if (query?.sort?.toLowerCase() === 'desc') {
                query.sort = { start: -1 };
            }
        }
        const { validOptions, errorDetails } = validateOptions(query, 'ACTIVATION');
        if (!validOptions) {
            throw boom.badRequest('Invalid query params', { details: errorDetails });
        }
        let valid = true;
        const errors = [];
        // const badKeys = Object.keys(filter).filter((p) => !validQueryKeys.includes(p));
        // if (!_.isEmpty(badKeys)) {
        //     valid = false;
        //     errors.push(`unsupported query parameter(s) [${badKeys}], only [${validQueryKeys}] are supported`);
        // }
        if (filter?.agentName && filter?.skillName) {
            valid = false;
            errors.push('"agentName" and "skillName" may NOT be used together');
        }
        if (!valid) {
            throw boom.badRequest(`Invalid query: ${errors.join(', ')}`);
        }
        try {
            activations = await synapse.statestore.listActivations(projectId, query);
            return { success: true, activations };
        } catch (err) {
            throw boom.internal(err.message);
        }
    }

    function vaidateScheduleName(name) {
        try {
            return QualifiedName.fromString(name).getNamespaceAndName();
        } catch (err) {
            if (err instanceof SyntaxError) {
                const message = `Invalid name for schedule. ${err.toString()}`;
                throw boom.badRequest(message);
            }
            throw err;
        }
    }

    // Perhaps move merge and agent invoke to behave similarly ...
    async function scheduleAgent(scheduleName, scheduleCron, synapseMsg, overwrite = false) {
        // 1) Check for existing schedule, fail if overwrite = false and exist = true
        let task;
        // Validate scheduleName
        const decodedName = vaidateScheduleName(scheduleName);
        const { projectId, token, serviceName } = synapseMsg;
        try {
            task = await taskCtrl.k8sClient.getResource(K8SRESOURCES.TASK, tok8sName(projectId, decodedName), getNamespace());
        } catch (err) {
            if (err?.response?.statusCode !== 404) {
                throw err;
            }
        }
        if (!overwrite && task) {
            throw boom.badRequest(`Schedule already exists with name "${scheduleName}"`);
        }
        // 2) validate crontab
        validateCron(scheduleCron);
        // 3) create new task
        const skill = await synapse.resourceProvider.getSkill(SHARED_PROJECT, 'sys-invoke-skill');
        if (!task) {
            const params = new InputMessage(synapseMsg).toParams();
            // Pass these to extras the task's args.
            params.serviceName = serviceName;
            params.scheduleName = tok8sName(projectId, decodedName); // TODO fix name clobbering, for now use yucky k8s name so it matches tasks list output
            delete params.headers; // TODO re-add headers.
            task = createK8sTask({
                actionName: 'invoke',
                projectId: projectId,
                name: tok8sName(projectId, scheduleName),
                skill,
                params,
                token,
                taskPoolName: undefined, //TODO parameterize taskPoolName
                outputName: 'output',
                schedule: scheduleCron,
            });
        }
        // 4) upsert task
        // Can't use expects name, doesn't support generate name, hard codes the namespace...
        // await taskCtrl.k8sClient.upsertResource(K8SRESOURCES.TASK, task);
        // TODO improve express common..
        return got(`${taskCtrl.k8sClient.kc.getCurrentCluster().server}/apis/fabric.cognitivescale.com/v1/namespaces/${getNamespace()}/tasks`, {
            ...taskCtrl.k8sClient.k8sOpts,
            method: 'POST',
            json: task,
        }).json();
    }
    const terseActivationResp = (activation) => nativeOmit(activation, 'token', 'plan', 'states', 'transits', 'channelId');
    
    async function getActivation(projectId, activationId, verboseRaw = 'false', reportRaw = 'false') {
        let verbose;
        let report;
        try {
            verbose = toBoolean(verboseRaw ?? false);
            report = toBoolean(reportRaw ?? false);
        } catch (err) {
            throw boom.badRequest('report or verbose query parameters are not valid boolean values');
        }
        const activation = await synapse.statestore.get(activationId);
        if (!activation) {
            throw boom.notFound(`activationId ${activationId} not found`);
        }
        // verify the activation belongs to the requested project
        if (activation?.projectId === projectId) {
            if (activation?.status === PENDING) {
                // If PENDING the transits won't be in mongo yet
                activation.transits = await synapse.statestore.getAllTransits(activationId);
            }    
            let result;
            if (report) {
                const elapsed = activation.end - activation.start;
                const transits = activation.transits.map((t) => {
                    const [type, name, title] = t.name.split(':');
                    return {
                        type,
                        name,
                        title,
                        start: t.start,
                        end: t.end,
                        elapsed: t.end - t.start,
                        status: t.status,
                    };
                });
                result = { elapsed, transits, status: activation.status };
            } else if (verbose) {
                result = activation;
            } else {
                result = terseActivationResp(activation);
            }
            return { success: true, ...result };
        }
        throw boom.notFound(`activationId ${activationId} does not belong to project ${projectId}`, { activationId });
    }
    /**
     * Invoke the latest version of an agent
     * @param req
     * @param sync - invoke agent synchronously
     * @return {Promise<void>}
     */

    async function invokeAgent(req, sync = false) {
        // Try to minimal processing here
        // Just parse the request and make a synapse (invoke) message
        const { username, jwt, headers } = req;
        const { agentName, projectId, serviceName } = req.params;
        // validate agentName, but ignore name length restrictions
        const FQAgentName = QualifiedName.fromString(agentName, false).toString();
        const activationId = uuid(); // Define if here so I can respond faster.
        const { scheduleCron, scheduleName: userScheduleName } = req.query;
        const {
            sessionId,
            correlationId,
            payload,
            properties,
        } = req.body;
        const context = {
            type: 'agents',
            agent: FQAgentName,
            service: serviceName,
        };
        logger.debug(`Invoking agent "${projectId}.${FQAgentName}" service "${serviceName}"`, { ...context });
        const plan = await synapse.mapping.getPlan(projectId, FQAgentName, serviceName);
        if (sync && plan.synchronous !== true) {
            const asyncSkillNames = plan.states.filter((s) => !s.synchronous).map((s) => s.ref.skillName);
            throw boom.badRequest(`${projectId}.${FQAgentName}.${serviceName} cannot be invoked synchronously, these skill(s) are async: ${asyncSkillNames.join(', ')}`);
        }
        const synapseMsg = new SynapseMessage({
            projectId,
            username,
            agentName: FQAgentName,
            agentTitle: plan?.agentTtile,
            serviceName,
            token: jwt,
            payload,
            properties,
            correlationId,
            requestId: activationId,
            sessionId,
            headers,
            sync,
        });
        if (scheduleCron?.trim().length > 0) {
            // default to agent name of scheduleName isn't provided.
            const scheduleName = userScheduleName || agentName;
            await scheduleAgent(scheduleName, scheduleCron, synapseMsg);
            const message = `Scheduled agent "${agentName}" with task "${projectId}-${scheduleName}" using cron "${scheduleCron}"`;
            logger.info(message, {
                projectId, agentName, serviceName, scheduleName, scheduleCron,
            });
            return { success: true, message };
        }
        const invoke = synapse.invokeAgent(synapseMsg);
        if (sync) {
            await invoke;
            // Have to re-fetch the activation as we don't know if there were multiple agent outputs ( and we merged the results )
            const { status, response } = await synapse.statestore.get(activationId); // TODO REMOVE DB access?
            if (status === ERROR) {
                logger.error(`Error invoking agent "${projectId}.${FQAgentName}" service "${serviceName}": ${response}`, context);
                throw boom.internal(response, { activationId });
            }
            return { success: true, activationId, response };
        }
        return { success: true, activationId };
    }

    /**
     * Run latest version of a skill
     * @param req
     * @param res
     * @param sync - invoke skill synchronously
     * @return {Promise<void>}
     */
    async function invokeSkill(req, res, sync) {
        const { username, jwt, body } = req;
        const { skillName, projectId, inputName } = req?.params;
        const payload = body?.payload ?? {};
        const properties = body?.properties ?? {};
        const sessionId = body?.sessionId;
        const correlationId = body?.correlationId;
        // validate namespace/agentName format..
        const FQSkillName = QualifiedName.fromString(skillName, false).toString();
        const requestId = uuid();
        const context = {
            type: 'skill',
            skill: FQSkillName,
            activationId: requestId,
            service: inputName,
        };
        logger.debug(`Invoking skill "${projectId}.${skillName}" input ${inputName}`, { ...context });
        // Add some basic validation ...
        const skill = await synapse.resourceProvider.getSkill(projectId, skillName);
        if (!skill) {
            throw boom.notFound(`Skill "${skillName}" not found in project "${projectId}"`);
        }
        // Validate service invoke input/output...
        const input = (skill.inputs || []).find((i) => i.name === inputName);
        if (!input) {
            throw boom.badRequest(`Input "${inputName}" not found in skill definition`);
        }
        if (sync) {
            // Check if given skill input is completely sync
            const { synchronous } = await synapse.mapping.checkSkill(projectId, skillName, inputName);
            if (!synchronous) {
                throw boom.badRequest(`Skill "${skillName}" cannot be invoked synchronously`);
            }
        }
        const synapseMsg = new SynapseMessage({
            requestId,
            projectId,
            username,
            skillName: FQSkillName,
            skillTitle: skill.title,
            inputName,
            token: jwt,
            sessionId,
            correlationId,
            properties,
            payload,
            sync,
        });
        // switch between sync/async...
        try {
            const invokeResp =  { success: true, activationId: requestId };
            const skillResp = await synapse.invokeSkill(synapseMsg);
            // Not sure when this broke, `skillResp?.response` doesn't get populated use outputMsg ..
            if ( skillResp?.outputMsg?.payload) {
                invokeResp.response = skillResp.outputMsg.payload;
            }
            return invokeResp;
        } catch (err) {
            // Add activationId to response
            logger.error(`Error invoking skill "${projectId}.${skillName}" input ${inputName}: ${err.message}`, context);
            return sendTsoaResponse(res, err?.output?.statusCode ?? 500, { success: false, message: err.message, activationId: requestId });
        }
    }
    async function handleMessageInvokeAgent(context, message) {
        const { projectId, agentName } = context;
        const data = nativeOmit(message, 'action');
        const { serviceName = '__unspecified__' } = data;
        logger.debug(`Invoking via ws agent "${projectId}.${agentName}" service "${serviceName}"`);
        try {
            const synapseMsg = new SynapseMessage({ ...context, ...data });
            const activation = await synapse.invokeAgent(synapseMsg);
            return ({ success: true, action: 'invokeAgent', activationId: activation });
        } catch (err) {
            logger.error(`Error invoking via ws agent "${projectId}.${agentName}" service "${serviceName}": ${err.message}`);
            return ({ success: false, action: 'invokeAgent', message: err.message });
        }
    }
    async function subscribeToAgentEvents(ws, req) {
        const { url, headers } = req;
        const pathRegex = /.*\/projects\/(.+)\/agentevents\/(.+)/.exec(url);
        if (!pathRegex) {
            ws.send(`ERROR: URL "${url}" doesn't support websockets`, () => ws.close(1003, 'Invalid request'));
            return;
        }
        const [, projectId, agentName] = pathRegex;
        const authBearer = headers?.authorization;
        if (!authBearer) {
            ws.send('ERROR: Unauthorized no authorization header provided', () => ws.close(1003, 'Unauthorized'));
            return;
        }
        const [, jwt] = authBearer.split(' ');
        const username = parseJwt(jwt)?.payload?.sub;
        //        const { username, jwt } = req;
        //        const { agentName, projectId } = req.params;
        const FQAgentName = QualifiedName.fromString(agentName, false).toString();
        const topic = WebSocketEventHandler.topicNameForAgent(projectId, FQAgentName);
        const filter = _.trim(req?.query?.filter);
        const messageDispatch = async (message) => {
            const { action } = message;
            if (action === 'invokeAgent') {
                return handleMessageInvokeAgent({
                    projectId,
                    username,
                    token: jwt,
                    agentName: FQAgentName,
                }, message);
            }
            return null;
        };
        await socketListener(ws, topic, filter, logger)
            .listen(synapse.eventHandler, messageDispatch);
    }

    async function agentPlanDiagram(projectId, agentName, serviceName) {
            const diagram = await synapse.planDiagram(projectId, agentName, serviceName);
            return { success: true, ...diagram };
    }

    function echo(req, res) {
        logger.info('echo called');
        sendResponse(res, 200, { success: true, message: 'echo' });
    }

    async function cancelActivation(projectId, activationId, inFlight) {
        const username = ctx.get('username');
        const state = await synapse.statestore.get(activationId);
        if ( !state?.status) {
            throw boom.notFound(`Activation ${activationId} not found`);
        }
        // IF I try to cancel a completed activation just return a nice message.
        if ( [ERROR, COMPLETE, CANCELLED].includes(state.status)) {
            return ({ success: true, message: `Activation is already ${state.status}, nothing to cancel` });
        }
        // Try to delete tasks first, if this fails user can reattempt as status stays pending.
        let message = `Activation ${activationId} cancelled by ${username}`;
        try {
            // 1) list all jobs submitted/running
            const { tasks } = await taskCtrl.listTasks(projectId, { filter: { activationId } });
            const taskNames = tasks.map(t => t.name);
            // 2)delete each one
            if (!inFlight) {
                await Promise.all(taskNames.map(taskName => taskCtrl.deleteTask(projectId, taskName)));
                message = `${message}, stopped tasks: ${taskNames.join(', ')}`;
            } else {
                message = `${message}, tasks left running (inFlight: true): ${taskNames.join(', ')}`;
            }
        } catch (err) {
            const errMsg = `Error cancelling activation ${activationId}: ${err.message}`;
            logger.warn(errMsg);
            throw boom.internal(errMsg);
        }
        logger.info(message);
        await synapse.statestore.endActivation(activationId, message, new Date().getTime(), CANCELLED);
        return ({ success: true, message });
    }

    return {
        agentPlanDiagram,
        echo,
        getActivation,
        invokeAgent,
        invokeSkill,
        listActivations,
        subscribeToAgentEvents,
        cancelActivation,
    };
};
