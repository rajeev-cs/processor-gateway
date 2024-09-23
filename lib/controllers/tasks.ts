/* eslint-disable @typescript-eslint/no-unused-expressions */
import _ from 'lodash';
import config from 'config';
import { injectable, inject } from 'inversify';
// eslint-disable-next-line import/no-unresolved
import { HTTPError } from 'got';
import * as Boom from '@hapi/boom';
import clientNode from '@kubernetes/client-node';
import { K8SRESOURCES, getNamespace } from '@tt-sensa/sensa-express-common/k8s.js';
import {
    toBoolean, parseIfJSON, validateOptions, Logger,
} from '@tt-sensa/sensa-express-common';
import * as Stream from 'stream';
import { SynapseMessage } from '../models/synapseMessage.js';
import { Tasks, TaskProjection } from '../models/task.model.js';
import { COMPLETE, ERROR, STARTED } from '../state/abstractStateStore.js';
import { tpl } from '../clients/k8sResources.js';
import { ManagedContentClient } from '../clients/cortexClient.js';
import { nativeOmit, notEmptyString, parseAuthHeader, streamToString } from '../utils.js';
import { Infra } from '../interfaces/Infra.js';
import { Synapse } from '../synapse.js';
import { TaskLogsResponse } from '../interfaces/TaskTypes.js';

const { CustomObjectsApi } = clientNode;
const PERSIST_TASKS = toBoolean(config.get('features.persist_tasks'));

export const TaskQueued = 'QUEUED';
export const TaskCancelled = 'CANCELLED';
export const TaskCompleted = 'COMPLETED';
export const TaskFailed = 'FAILED';
export const TaskActive = 'ACTIVE';
export const TaskPaused = 'PAUSED';

export const parse = (obj) => {
    if ((!!obj) && (obj.constructor === Object)) {
        return obj;
    }
    return JSON.parse(obj);
};

const statusMapping = {
    [TaskFailed]: ERROR,
    [TaskCompleted]: COMPLETE,
    [TaskCancelled]: ERROR, // Map Cancelled -> ERROR
};
function translateStatus(status) {
    // Map job/skill status values from operator to GW values
    return statusMapping[status] || status;
}
function skillNameFromTransit(t) {
    if (!t.name) {
        return ['', ''];
    }
    const parts = t.name.split(':');
    if (parts.length >= 3) {
        return [parts[1], parts[2]];
    }
    return [t.name, t.name];
}

function getStatus(task) {
    // If suspend flag set
    if (task?.spec?.schedule) {
        if (task?.spec?.suspend === true) {
            return TaskPaused;
        }
        return TaskActive;
    }
    return task?.status?.state?.toUpperCase();
}
/*
       Convert task to task db/response format
 */
function k8sTask2dbTask(task, skinny = false) {
    const skinnyResp = {
        name: task?.metadata?.name,
        actionName: task?.metadata?.annotations?.['fabric.actionName'] ?? task?.spec?.actionName,
        activationId: task?.metadata?.labels?.['fabric.activationId'],
        agentName: task?.metadata?.annotations?.['fabric.agentName'],
        endTime: task?.status?.endTime,
        projectId: task?.metadata?.labels?.['fabric.project'],
        schedule: task?.spec?.schedule,         // only for scheduled tasks
        skillName: task?.metadata?.annotations?.['fabric.skillName'] ?? task?.spec?.skillName,
        startTime: task?.spec?.schedule ? task?.metadata?.creationTimestamp : task?.status?.startTime, // Return creationTime for scheduled tasks ( no startTime )
        state: getStatus(task),  // TODO move this to the operator and support PAUSED state on k8s
        username: task?.metadata?.annotations?.['fabric.username'],
    };
    if (skinny) {
        return skinnyResp;
    }
    const {
        channelId, messageId, activationId, outputName,
    } = JSON.parse(task?.spec?.payload ?? '{}');
    const cronJob = (task?.metadata?.ownerReferences ?? []).find((o) => o.kind === 'CronJob');
    // add more atts to skinny response
    return {
        ...skinnyResp,
        // Try phoenix labels, then try owner details for cronjobs
        jobType: task?.metadata?.labels?.['fabric.jobtype'] ?? cronJob?.kind,
        fabricResource: task?.metadata?.labels?.['fabric.resname'] ?? cronJob?.name,
        resourceType: task?.metadata?.labels?.['fabric.restype'],
        // Schedule related configs
        concurrencyPolicy: task?.spec?.concurrencyPolicy,
        suspend: task?.spec?.suspend ?? false,
        // Store original task resource just in case
        resource: JSON.stringify(task),
        channelId,
        activationId,
        messageId,
        outputName,
    };
}
function formatResource(task, k8sFormat = false) {
    if (k8sFormat) {
        return {
            k8s: task,
            name: task.metadata.name,
            labels: task.metadata.labels,
        };
    }
    return nativeOmit(k8sTask2dbTask(task), 'resource');
}
export const ERROR_MESSAGES = {
    LIST: (err) => `Failed to list tasks: ${err}`,
    DELETE: (err, name) => `Failed to delete task "${name}": ${err}`,
    PAUSE: (err, name) => `Failed to pause task "${name}": ${err}`,
    RESUME: (err, name) => `Failed to resume task "${name}": ${err}`,
    GET: (err, name) => `Failed to fetch task "${name}": ${err}`,
    LOGS: (err, name) => `Failed to fetch logs for task "${name}": ${err.message || err.toString()}`,
};

// @ts-ignore
@injectable()
export class TaskCtrl {
    private logger: Logger;

    private k8sClient: any;

    private persist: boolean;

    private k8sCustomApi: any;

    constructor(
        @inject(Infra) private infra: Infra,
        @inject(Synapse) private synapse: Synapse,
    ) {
        this.logger = infra.logger;
        this.k8sClient = infra.k8sClient;
        this.persist = PERSIST_TASKS; // TODO inject for tests.
        this.synapse = synapse;
        this.k8sCustomApi = infra.k8sClient?.kc?.makeApiClient(CustomObjectsApi);
    }

    /**
     * Handles HTTPErrors from k8s api's and constructs a response body to pass to sendResponse() for Task api's.
     * @param err
     * @param name
     * @param message Optional message to use if error is not 404
     * @returns {{code: number, success: boolean, message}}
     * @private
     */
    #constructError(err, name, message) {
        const errBody = {
            success: false,
            code: 500,
            message,
        };
        // We want to handle 404 explicitly, everything else is 500 from cortex
        if (err instanceof HTTPError) {
            errBody.code = err?.response?.statusCode ?? 500;
        }
        if (Boom.isBoom(err)) {
            errBody.code = err?.output?.statusCode ?? 500;
        }
        this.logger.warn(`${message}`);
        return errBody;
    }

    static #isDone(task) {
        const state = task?.state?.toUpperCase();
        return state === TaskCompleted || state === TaskFailed || state === TaskCancelled;
    }

    /**
     * Handle send message requests from jobs, this will generate a monotonically increasing `messageId` that is passed downstream to track each execution.
     * This will replace log output as payload to downstream skills.  This also resumes an agent execution after a job completes.
     * @param req
     * @param res
     * @returns {Promise<void>}
     */
    // TODO refactor code same as taskCallback but not expected to complete a skill/agent/etc
    async handleMessage(req) {
        const { jwt, username } = parseAuthHeader(req);
        const { activationId, channelId, outputName } = req.params;
        const payload = req?.body?.payload ?? req?.body;
        const { plan } = await this.synapse.statestore.getAgentState(activationId);
        const { agentName, agentTitle, projectId, serviceName } = plan || {}; // Won't have a plan with skill invokes
        if (this.logger.debug) this.logger.debug(`Got task message for agent: ${projectId}.${agentName}`, { activationId, channelId, outputName });
        // Figure what skill sent the message
        const transits = await this.synapse.statestore.getToTransits(activationId, channelId);
        if (_.isEmpty(transits)) {
            // TODO mark activation as failed ??
            const message = `Send message unable to locate job transit for ${channelId}`;
            this.logger.info(message, { activationId, agentName, projectId, serviceName });
            throw Boom.notFound(message);
        }
        // Get message number and bump stats
        const cnt = await this.synapse.statestore.jobMessageSent(activationId, channelId);
        const synapseMessage = new SynapseMessage({
            agentName,
            agentTitle,
            channelId,
            outputName,
            payload,
            projectId,
            // TODO ???
            // properties: this.synapse.properties,
            requestId: activationId,
            serviceName,
            // TODO ???
            // sessionId: this.synapse.sessionId,
            timestamp: Date.now(),
            messageId: `${channelId}:${cnt}`,
            token: jwt,
            username,
            plan,
        });
        const outputEvent = {
            agentName,
            skillName: req?.body?.skillName,
            refId: channelId,
            requestId: activationId,
            outputName,
            message: synapseMessage.toEventObject(),
        };
        try {
            await this.synapse.eventHandler.publishEvent(activationId, 'skill.output', outputEvent);
            // if agentName == undefined this is likely a skill calling me.
            if (!_.isEmpty(agentName)) {
                await this.synapse._processMessage(synapseMessage);
            } else {
                // store payload for task callback to finalise the job...
                await this.synapse.statestore.setPayload(activationId, payload);
            }
            // store message count for this skill
            return {
                success: true,
                message: `Message ${cnt} submitted `,
            };
        } catch (err: any) {
            const message = `Send Message error: ${err.message}`;
            await this.synapse.statestore.jobMessageError(activationId, channelId);
            this.logger.error(message, {
                activationId,
                channelId,
            });
            throw Boom.internal(message);
        }
    }

    async #listCustomResources(type, namespace, labelSelectors) {
        const CustomResourceDefs = _.map(K8SRESOURCES, (r) => ({
            group: 'fabric.cognitivescale.com',
            single: r,
            plural: `${r}s`,
            version: 'v1',
        }));
        const crd = CustomResourceDefs.find((c) => c.single === type);
        const { group, version, plural } = crd;
        const fieldSelector = null;
        const k8sResponse = await this.k8sCustomApi.listNamespacedCustomObject(group, version, namespace, plural, null, null, null, fieldSelector, labelSelectors.toString());
        return k8sResponse?.response?.body;
    }

    /**
     * Reads tasks directly from k8s tasks resources
     * @param filter
     * @returns {Promise<{skillName: undefined, name: *, startTime: *, state: *, endTime: *, actionName: undefined, activationId: undefined}[]>}
     */
    async #listK8sTasks({
        projectId, activationId, scheduled, skillName, actionName, username, agentName,
    }) {
        const labelSelectors = [
            tpl('fabric.project', projectId), // Always filter by project id
        ];
        // These are the only query parameters understood
        if (notEmptyString(activationId)) labelSelectors.push(tpl('fabric.activationId', activationId));
        if (this.logger.debug) this.logger.debug(`Querying tasks for project ${projectId} with opts ${JSON.stringify(labelSelectors)}`);
        const taskList = await this.#listCustomResources(K8SRESOURCES.TASK, getNamespace(), labelSelectors);
        const allTasks = (taskList?.items ?? []).map((t) => k8sTask2dbTask(t, true));
        const filters: string[][] = [];
        // Action/Skill/Agent/User are post-processing the results
        if (notEmptyString(actionName)) filters.push(['actionName', 'equals', actionName]);
        if (notEmptyString(agentName)) filters.push(['agentName', 'equals', agentName]);
        if (notEmptyString(skillName)) filters.push(['skillName', 'equals', skillName]);
        if (notEmptyString(username)) filters.push(['username', 'equals', username]);
        if (scheduled) filters.push(['schedule', 'exists', '']);
        const ops = {
            equals: (obj, att, val) => obj[att] === val,
            exists: (obj, att) => !_.isEmpty(obj[att]),
        };
        const filteredTasks = allTasks.filter((t) => _.every(filters.map(([att, op, value]) => ops[op](t, att, value))));
        return filteredTasks;
    }

    /**
     * Constructs a query filter object to be used for mongo, no fields will be added to the filter unless EXPLICITLY added
     * via this function.
     * @param projectId The name of the project
     * @param q generic query args to include in the filter
     * @returns {{_tenantId: *}}
     */
    #constructTaskFilter(projectId, { filter }) {
        const {
            actionName, skillName, channelId, activationId, startAfter, startBefore, endAfter, endBefore, state,
        } = parse(filter);
        const afterEqual = (t) => ({ $gte: Number(t) });
        const before = (t) => ({ $lt: Number(t) });
        let result: any = { projectId };
        actionName !== undefined && (result.actionName = actionName);
        activationId !== undefined && (result.activationId = activationId);
        channelId !== undefined && (result.channelId = channelId);
        skillName !== undefined && (result.skillName = skillName);
        startAfter !== undefined && (result.startTime = afterEqual(startAfter));
        startBefore !== undefined && (result.startTime = before(startAfter));
        endAfter !== undefined && (result.endTime = afterEqual(endAfter));
        endBefore !== undefined && (result.endTime = before(endAfter));
        state !== undefined && (result.state = state.toUpperCase());
        return result;
    }

    /**
     * Return an array of task names that exist in k8s under the specified project
     * @param req
     * @param res
     * @returns {Promise<void>}
     */
    async listTasks(projectId, query) {
        // eslint-disable-next-line prefer-const
        let { validOptions, errorDetails } = validateOptions(query, 'TASK');
        // let scheduled = false;
        // try {
        //     scheduled = toBoolean(query?.filter?.scheduled ?? false);
        // } catch (err) {
        //     errorDetails.push({ type: '', message: 'Invalid value for scheduled: expect boolean' });
        //     validOptions = false;
        // }
        if (!validOptions) {
            throw Boom.badRequest('Invalid query params', { details: errorDetails });
        }
        const {
            limit, skip, sort,
        } = query;
        try {
            const { actionName, skillName, activationId, scheduled, username, agentName } = query?.filter ?? {};
            let tasks;
            if (!this.persist || scheduled) {
                tasks = await this.#listK8sTasks({
                    projectId,
                    activationId,
                    skillName,
                    actionName,
                    scheduled,
                    username,
                    agentName,
                });
            } else {
                const mongoFilter = this.#constructTaskFilter(projectId, query);
                let sortStart = {};
                if (sort) {
                    // check if sort is valid json, if not fall back on old logic sorting state.start by ascending
                    // when we can't parse the option
                    try {
                        sortStart = JSON.parse(sort);
                    } catch (e) {
                        if (_.lowerCase(sort)
                            .startsWith('desc')) {
                            sortStart = { startTime: -1 };
                        } else if (_.isNumber(sort)) {
                            sortStart = { startTime: sort };
                        } else {
                            sortStart = { startTime: 1 };
                        }
                    }
                }
                tasks = await Tasks.find(mongoFilter, TaskProjection)
                    .sort(sortStart)
                    .skip(_.toInteger(skip))
                    .limit(_.toInteger(limit))
                    .lean();
            }
            return {
                success: true,
                tasks: tasks.map((t) => ({ ...t, startTime: t?.startTime?.toString(), endTime: t?.endTime?.toString() })),
            };
        } catch (err) {
            const msg = ERROR_MESSAGES.LIST(err);
            const e = this.#constructError(err, 'LIST-TASKS', msg);
            throw Boom.internal(e.message);
        }
    }

    /**
     * Deletes a task resource from k8s if it exists and is part of the requested project
     * @param projectId
     * @param taskId
     * @returns {Promise<{}>}
     */
    async deleteTask(projectId, taskId) {
        await this.#getTaskCheckProject(projectId, taskId);
        try {
            await this.k8sClient.deleteResource('task', taskId, getNamespace());
        } catch (err: any) {
            if (err?.response?.statusCode === 404) {
                const msg = `Task ${taskId} not found in project ${projectId}`;
                throw Boom.notFound(msg);
            }
            throw new Boom.Boom(`Error deleting task ${taskId}: ${err.message}`, { statusCode: err?.response?.statusCode ?? 500 });
        }
        return {
            success: true,
            message: `Successfully marked task ${taskId} for delete`,
        };
    }

    async #getTaskCheckProject(projectId, name) {
        const decodeName = decodeURIComponent(name);
        const msg = `Task ${name} not found in project ${projectId}`;
        let task;
        try {
            task = await this.k8sClient.getResource(K8SRESOURCES.TASK, decodeName, getNamespace());
        } catch (err: any) {
            if (err?.response?.statusCode === 404) {
                throw Boom.notFound(msg);
            }
            throw new Boom.Boom(`Error getting task ${name}: ${err.message}`, { statusCode: err?.response?.statusCode ?? 500 });
        }
        // check that task belongs to project
        const detectedProject = task?.metadata?.labels?.['fabric.project'];
        if (detectedProject !== projectId) {

            throw Boom.notFound(msg);
        }
        return task;
    }

    /**
     * Pause a task resource from k8s if it exists,is part of the requested project, and is scheduled
     * @param projectId
     * @param taskId
     * @returns {Promise<{}>}
     */
    async pauseSchedule(projectId, taskId) {
        this.logger.debug(`Attempting to pause task ${taskId} for project ${projectId}`);
        const task = await this.#getTaskCheckProject(projectId, taskId);
        const schedule = task?.spec?.schedule;
        if (_.isEmpty(schedule)) {
            const msg = `Task ${taskId} cannot be paused not scheduled ${projectId}`;
            Boom.badRequest(msg);
        }
        task.spec.suspend = true;
        await this.k8sClient.upsertResource('task', task);
        return {
            success: true,
            message: `Successfully paused task "${taskId}"`,
        };
    }

    /**
     * Resume a task resource from k8s if it exists,is part of the requested project, and is paused
     * @param projectId
     * @param taskId
     * @returns {Promise<{}>}
     */
    async resumeSchedule(projectId, taskId) {
        this.logger.debug(`Attempting to resume task ${taskId} for project ${projectId}`);
        const task = await this.#getTaskCheckProject(projectId, taskId);
        const schedule = task?.spec?.schedule;
        const suspend = task?.spec?.suspend; // avoid un-needed updates ...
        if (_.isEmpty(schedule) || !suspend) {
            const msg = `Task "${taskId}" cannot be resumed not scheduled or suspended`;
            Boom.badRequest(msg);
        }
        task.spec.suspend = false;
        await this.k8sClient.upsertResource('task', task);
        return {
            success: true,
            message: `Successfully resumed task "${taskId}"`,
        };
    }

    /**
     * Create managed content key for fetching/storing task artifacts such as logs.
     * NOTE: This function is also present in the cortex operator go code
     * @param name
     * @param artifact
     * @returns {string}
     */
    static #genTaskArtifactKey(name, artifact = 'logs.json') {
        return `tasks/${name}/${artifact}`;
    }

    async #getTaskLogsFromManagedContent(projectId: string, name: string, jwt: string) {
        this.logger.debug(`Checking blob store for task ${projectId}.${name} logs`);
        const mcClient = new ManagedContentClient(jwt);
        try {
            const logData = await mcClient.download(projectId, TaskCtrl.#genTaskArtifactKey(name));
            logData.on('error', (err) => {
                const msg = ERROR_MESSAGES.LOGS(err, name);
                this.logger.warn(msg);  // can't throw in a call back..
            });
            return logData;
        } catch (err: any) {
            throw Boom.internal(err.message);
        }
    }

    #streamLogsToReadable(logsResponse: any[]) {
        const readable = new Stream.Readable();
        logsResponse.forEach((l) => {
            readable.push(l?.logs);
        });
        readable.push(null); // Done
        return readable;
    }

    #filterLogsByPodName(logsResponse: any[], podName = '') {
        /** 
         * Usually for task it is always single object array but incase of
         * spark logs we may get multiple object in array one for parent task and
         * one for driver pod or pod matching criteria. In that case instead of 
         * sending logs as array item we are combining logs with line separator and
         * sending text logs back which will pretty print logs
         */
        let resp = [];
        if (_.isEmpty(podName)) {
            resp = _.map(logsResponse, 'logs') ?? [];
        } else {
            const filteredResponse = _.filter(logsResponse, { name: podName });
            resp = _.map(filteredResponse, 'logs') ?? [];
        }
        return _.join(resp, '\n');
    }

    #filterLogsByPodNameToReadable(logsResponse: any[], podName = '') {
        if (_.isEmpty(podName)) {
            return this.#streamLogsToReadable(logsResponse);
        } else {
            const filteredResponse = _.filter(logsResponse, { name: podName });
            return this.#streamLogsToReadable(filteredResponse);
        }
    }

    /**
     * Fetches the pod logs of a Task as an array of log message objects, returns an empty array [] if no pod is found
     * @param projectId
     * @param name
     * @param jwt
     * @param raw
     * @param follow
     * @param podName
     * @returns {Promise<void>}
     */
    async getTaskLogs(projectId: string, name: string, jwt: string, raw = false, follow = false, podName = ''): Promise<Stream.Readable | TaskLogsResponse> {
        let logs;
        const { task } = await this.getTask(projectId, name);
        // If task isn't completed try k8s for "live logs"
        if (!TaskCtrl.#isDone(task)) {
            this.logger.debug(`Checking k8s for task ${projectId}.${name} logs`);
            const labelSelector = [
                tpl('job-name', name),
                tpl('fabric.project', projectId), // this label is set on the task but not pod
            ];
            await this.#getTaskCheckProject(projectId, name);
            if (follow) {
                return this.k8sClient.getResourceLiveLogs('fabric-action', labelSelector, getNamespace(), {});
            } else {
                const logsResponse = await this.k8sClient.getResourceLogs('fabric-action', labelSelector, getNamespace());
                if (raw) {
                    return this.#filterLogsByPodNameToReadable(logsResponse, podName);
                }
                logs = this.#filterLogsByPodName(logsResponse, podName);
            }
        } else {
            const logData = await this.#getTaskLogsFromManagedContent(projectId, name, jwt);
            if (raw) {
                return logData;
            }
            logs = await streamToString(logData);
        }
        return {
            success: true,
            logs,
        };
    }

    // copy/paste from internal resources.js
    /**
     * Describes a Task specification that currently exists in k8s, optionally allows returning the full k8s resource
     * when req.query.k8s is true.
     */
    async getTask(projectId: string, taskId: string, k8sFormat = false): Promise<any> {
        const name = decodeURIComponent(taskId);
        this.logger.info(`Attempting to fetch task ${name}`);
        if (this.persist) {
            const rawTask = await Tasks.findOne({
                name,
                projectId,
            }).lean();
            if (rawTask !== null) {
                const resource = parseIfJSON(rawTask.resource);
                const message = resource?.status?.message;
                const reason = resource?.status?.reason;
                const task = nativeOmit(rawTask, '_id', '__v', 'resource');
                if (k8sFormat) return { success: true, task, k8s: resource };
                return {
                    success: true,
                    task: { ...task, message, reason },
                };
            }
        }
        // Keep K8s based tasks, in case we don't want to persist tasks to mongo
        // return full k8s resource
        let k8sTask;
        try {
            k8sTask = await this.k8sClient.getResource(K8SRESOURCES.TASK, name, getNamespace());
        } catch (err: any) {
            if (err?.response?.statusCode === 404) {
                throw Boom.notFound(`Task ${name} not found in project ${projectId}`);
            }
            throw new Boom.Boom(err.message, { statusCode: err?.response?.statusCode ?? 500 });
        }

        const detectedProject = k8sTask?.metadata?.labels?.['fabric.project'];
        if (detectedProject !== projectId) {
            const msg = `Task ${name} not found in project ${projectId}`;
            throw Boom.notFound(msg);
        }
        const task = formatResource(k8sTask, k8sFormat);
        if (this.logger.debug) this.logger.debug(`returning task ${name}: ${JSON.stringify(task)}`);
        return {
            success: true,
            task,
        };
    }

    /**
     * Handle task callback id the task is part of an agent's execution,  this resumes the agent's down stream skills
     * @param activationId
     * @param channelId
     * @param messageId
     * @param outputName
     * @param status
     * @param passedPayload
     * @param jwt
     * @param username
     * @returns {Promise<{message: string}>}
     */
    async handleTaskCallback({
        activationId, channelId, messageId, outputName, status, payload: passedPayload, jwt, username,
    }) {
        const payload = await this.synapse.statestore.getPayload(activationId) ?? passedPayload; // called send_message() and stashed the payload
        // TODO remove/reduce db access...
        const state: any = await this.synapse.statestore.get(activationId);
        const {
            agentName, agentTitle, projectId, serviceName, properties, sessionId,
        } = state;
        const context = {
            activationId,
            messageId,
            username,
        };
        const end = Date.now();
        if (_.isEmpty(state)) {
            const message = `Activation for task ${activationId} not found`;
            this.logger.warn(`${activationId} callback failed: ${message}`, context);
            throw Boom.notFound(message);
        }
        // Find transits, filter by state === STARTED, we may have more than one
        // Worse case we'll complete the wrong transit so time stamps will be off :(
        // TODO revisit this and use a unique transit id to make this logic more robust
        const foundTransits = await this.synapse.statestore.getToTransits(activationId, channelId, messageId);
        const transit = _.find(foundTransits, (f) => f.status === STARTED);
        if (_.isEmpty(transit)) {
            const message = `Task callback failed no matching transit for ${activationId}/${channelId}`;
            this.logger.warn(`${activationId} callback failed: ${message}`, { ...context, foundTransits });
            throw Boom.notFound(message);
        }
        const [skillName, skillTitle] = skillNameFromTransit(transit);
        // This completes transit started in Synapse._processSkill()
        await this.synapse.statestore.completeTransit(activationId, transit.from, transit.to, status, transit.messageId);
        // If agentName is empty assume a skill,  if status not COMPLETE mark activation as failed...
        if (_.isEmpty(agentName)) {
            await this.synapse.statestore.endActivation(activationId, payload, end, status);
            // TODO am I missing skill/agent output here ... does it matter for skill invokes ??
        } else {
            const { plan } = await this.synapse.statestore.getAgentState(activationId);
            const synapseMessage = new SynapseMessage({
                agentName,
                agentTitle,
                channelId: transit.to,
                messageId,
                outputName,
                payload,
                plan,
                projectId,
                properties,
                requestId: activationId,
                serviceName,
                sessionId,
                timestamp: end,
                token: jwt,
                username,
            });
            const stats = await this.synapse.statestore.getJobMessageStats(activationId, channelId);
            if (stats.received > 0) {
                // Attempt agent output, this call will ONLY finish the activation if transits and messages all done.
                // This is needed for agent using jobs/agent invoke to go from PENDING -> COMPLETE
                await this.synapse._handleAgentOutput(synapseMessage, agentName);
            } else {
                const outputEvent = {
                    agentName,
                    skillName,
                    refId: channelId,
                    requestId: activationId,
                    outputName,
                    message: synapseMessage.toEventObject(),
                };
                await this.synapse.eventHandler.publishEvent(activationId, 'skill.output', outputEvent);
                if (status === COMPLETE) {
                    await this.synapse._processMessage(synapseMessage);
                } else {
                    await this.synapse._handleAgentError(
                        synapseMessage,
                        `Error invoking skill "${skillTitle}" (${skillName}): callback received ${status}, response payload: ${_.isString(payload) ? payload : JSON.stringify(payload)}`);

                }
            }
        }
        return { message: `Task callback for ${activationId} skill "${skillTitle}" (${skillName}) succeeded` };
    }

    /**
     * Store k8s task resources in the mongo task collection, call handleCallback() on COMPLETE|FAILED tasks
     * @param req
     * @param res
     * @returns {Promise<void>}
     */
    async storeTask(req) {
        const { body } = req;
        const { jwt, username } = parseAuthHeader(req);
        const { payload, task } = body;
        try {
            const taskInst: any = k8sTask2dbTask(task);
            // tasks must have a project
            if (_.isEmpty(taskInst.projectId)) {
                throw Boom.badRequest(`spec.projectId is required task: ${taskInst.name}`);
            }
            let message = `Task ${taskInst.name} updated: ${taskInst.state}`;
            this.logger.debug(message);
            // write task record to mongo
            if (this.persist) {
                await Tasks.findOneAndUpdate({ name: taskInst.name }, taskInst, { upsert: true });
            }
            const {
                state: rawState, activationId, channelId, messageId, outputName,
            } = taskInst;
            const state = rawState.toUpperCase();
            if ((state === TaskCompleted || state === TaskFailed) && activationId !== undefined) { // Skip callback id not activation
                const resp = await this.handleTaskCallback({
                    activationId,
                    channelId,
                    messageId,
                    outputName,
                    payload,
                    jwt,
                    status: translateStatus(state),
                    username,
                });
                message = resp.message;
            }
            return { success: true, message };
        } catch (err) {
            const message = `Error storing task ${task?.metadata?.name}: ${err.message}`;
            this.logger.error(message, {}, err);
            return { success: false, message };
        }
    }

    /**
     * Original task callback api replaced with storeTasks(), this CANNOT be removed as it is used by the agent invoke skill.
     * Most of the logic is in handleTaskCallback()
     * @param req
     * @param res
     * @returns {Promise<void>}
     */
    async taskCallBack(req) {
        const { jwt, username } = parseAuthHeader(req);
        const { activationId, channelId } = req.params;
        const messageId = req?.query?.messageId;
        const context = {
            activationId,
            username,
        };
        // status can come as either a query param ( operator callback ) or a field in the body ( agent callback )
        const status = translateStatus(((req?.query?.state ?? req?.body?.status) ?? COMPLETE).toUpperCase());
        const outputName = req?.body?.outputName ?? 'output';
        try {
            // This is a bit ugly, neededs to deal with older callers.
            // Expected format from most skills
            //  older skill returned payload
            //  poorly written skill just take the response body.
            let payload = (req?.body?.response ?? req?.body?.payload) ?? req.body;
            const { message } = await this.handleTaskCallback({
                activationId,
                channelId,
                messageId,
                outputName,
                status,
                payload,
                jwt,
                username,
            });
            // get response (send_message) or payload (task callback) otherwise use entire message ...
            // channelId is the skillRef's refId
            this.logger.info(message, context);
            return {
                success: true,
                message,
            };
        } catch (err: any) {
            const message = `Task callback failed ${activationId}: ${err.message}`;
            this.logger.error(message, context);
            throw Boom.internal(message);
        }
    }
}
