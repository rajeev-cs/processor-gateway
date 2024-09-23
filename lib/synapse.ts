import _ from 'lodash';
import config from 'config';
import { Logger, parseIfJSON, toBoolean } from '@tt-sensa/sensa-express-common';
import * as boom from '@hapi/boom';
import got, { OptionsInit } from 'got';
import { Redis } from 'ioredis';
import { BroadcastChannel } from 'broadcast-channel';
import PQueue from 'p-queue';
import { setTimeout } from 'timers/promises';
import redisSemaphore from 'redis-semaphore';
import { injectable, inject } from 'inversify';
import { Skill } from './skill.js';
import { Infra } from './interfaces/Infra.js';
import {
 PENDING, ERROR, COMPLETE, RETRY, StateStore, 
} from './state/abstractStateStore.js';
import { SecretsClient } from './clients/cortexClient.js';
import synapseMessage, { SynapseMessage } from './models/synapseMessage.js';
import mappingFn from './mapping.js';
import { ResourceProvider } from './clients/resourceProvider.js';
import { RuntimeProvider } from './actions/runtimeProvider.js';
import { nativeOmit } from './utils.js';

const { Mutex } = redisSemaphore;
const MAX_ATTEMPTS = 3;
const RETRY_WAIT = 2;
const RETRY_MULTIPLIER = 0.5;
const RETRY_JITTER = true;
const STATS = 'stats';
const SINGLE = 'single';
const MERGE = 'merge';

const SYNAPSE_CONCURRENCY = _.toInteger(config.synapse_concurrent ?? 20);
// Use transits for agent completion, all must COMPLETE for activation to be COMPLETE.
const LEGACY_AGENT_COMPLETE = toBoolean(config.features.legacy_agent_complete);
function retryBackoffMS(attempts) {
    if (attempts <= 0) {
        return 0;
    }
    // random jitter [-5, 5];
    const jitter = RETRY_JITTER ? Math.floor((Math.random() - 0.5) * 10) : 0;
    return Math.abs((RETRY_WAIT * (RETRY_MULTIPLIER ** attempts) + jitter) * 1000);
}
const genTransitName = (step) => {
    const name = step?.ref?.skillName || step?.ref?.name;
    // default title to skill name so we avoid undefined | ""
    return `${step?.type}:${name}:${step?.ref?.title || name}`;
};
/**
 * Use agentProperties to filter header that will be propagated to skills
 * @param agentProperties
 * @param reqHeaders
 * @return {{}}
 */
function getFilteredHeaders(agentProperties, reqHeaders) {
    const allowedHeaders = {};
    if (_.isEmpty(reqHeaders)) {
        return allowedHeaders;
    }
    const allowedHeadersProp = agentProperties.find((p) => p.name === 'allowedHeaders');
    if (!allowedHeadersProp || _.isEmpty(allowedHeadersProp.value)) {
        return allowedHeaders;
    }
    const propHeaders = allowedHeadersProp.value.toLowerCase()
        .split(',')
        .map((el) => el.trim());
    if (propHeaders.includes('*')) {
        return reqHeaders;
    }
    Object.keys(reqHeaders)
        .forEach((headerName) => {
        // Search is case-insensitive
        if (propHeaders.includes(headerName.toLowerCase())) {
            // filter the whitelisted http headers
            // Write out in original case
            allowedHeaders[headerName] = reqHeaders[headerName];
        }
    });
    return allowedHeaders;
}

interface OutputEvent {
    requestId: string;
    agentName?: string;
    message: {
        agentName?: string;
        skillName?: string;
        requestId: string,
        projectId: string,
        sessionId: string,
        timestamp: string,
        payload: any,
    },
}

@injectable()
export class Synapse {
    private logger: Logger;

    statestore: StateStore;

    private redis: Redis;

    private resourceProvider: ResourceProvider;

    eventHandler: any;

    private runtimeProvider: RuntimeProvider;

    private mapping: any;

    private connectors: any[];  // TODO how is this used anymore ?

    private queue: PQueue;

    constructor(
        @inject(Infra) infra: Infra,
        @inject(StateStore) stateStore: StateStore,
        @inject(RuntimeProvider) runtimeProvider: RuntimeProvider) { // TODO connectors[]
        this.logger = infra.logger;
        this.statestore = stateStore;
        this.redis = infra.redis;
        this.resourceProvider = infra.resourceProvider;
        this.eventHandler = infra.eventHandler;
        this.runtimeProvider = runtimeProvider;
        this.connectors = []; // connectors;
        // Apply clean cache to these events to allow agent updates < 3600 secs.
        // Create an instance here as it needs more configs, i.e. resourceProvider
        this.mapping = mappingFn(infra);
        this.queue = new PQueue({ concurrency: SYNAPSE_CONCURRENCY });
        // This is a work around to allow the invokeAgent system skill to call an agent
        // There is a cyclic dependency with Synapse, RuntimeProvider, so I can use agentCtrl directly
        const invokeChannel = new BroadcastChannel('invoke');
        invokeChannel.onmessage = async (msg) => {
            try {
                await this.invokeAgent(new SynapseMessage(msg));
            } catch (err) {
                // handle throw that aren't handled during agent execution, such as missing agent.
                this._handleCallBack(msg, err.message, ERROR);
            }
        };
    }

    _messageToOutputEvent(m) {
        const output: OutputEvent = {
            requestId: m.requestId,
            message: {
                requestId: m.requestId,
                projectId: m.projectId,
                sessionId: m.sessionId,
                timestamp: m.timestamp,
                payload: m.payload,
            },
        };
        if (m.agentName) {
            // TODO Why twice ??
            output.agentName = m.agentName;
            output.message.agentName = m.agentName;
        }
        if (m.skillName) {
            output.message.skillName = m.skillName;
        }
        return output;
    }

    async _handleCallBack(m, response, status) {

        // TODO santize URL
        const cbUrl = m?.properties?.callbackUrl;
        // I don't want the callback to throw, so just logging messages ...
        try {
            if (cbUrl?.trim()?.length > 0) {
                const parsedUrl = new URL(cbUrl);
                if (parsedUrl.protocol.startsWith('connector')) {
                    const connector = this.connectors?.[parsedUrl.host];
                    if (!connector) this.logger.error(`Callback failed: Unknown connector callback ${parsedUrl.host}`, this._loggerContext(m));
                    return connector.handleCallBack(m, response, status);
                }
                const options: OptionsInit = {
                    //                responseType: 'json',
                    headers: { Authorization: `Bearer ${m.token}` },
                    method: 'POST',
                    // Send status in BOTH body and query params
                    // Merge user defined query provided on callback url and status
                    searchParams: { ..._.fromPairs([...parsedUrl.searchParams]), status },
                    json: {
                        status,
                        response,
                    },
                };
                await got(cbUrl, options);
            }
        } catch (err: any) {
            this.logger.error(`Callback failed: ${err.message}`, this._loggerContext(m));
        }
        return undefined;
    }

    _loggerContext(m) {
        const context = (m instanceof SynapseMessage) ? m.getLogMeta() : nativeOmit(m, 'jwt', 'payload', 'token', 'timestamp', 'plan');
        if (m.agentName) context.agent = m.agentName;
        if (m.skillName) context.skill = m.skillName;
        return context;
    }

    async callActivationLater(mesg, attempts) {
        const waitTime = retryBackoffMS(attempts);
        this.logger.info(`Resubmitting ${mesg.requestId} in ${waitTime}`);
        await setTimeout(waitTime);
        return this.invokeAgent(mesg);
    }

    // Need some way to inject when to retry logic until I can re-enable this ..
    async handleRetry(mesg, errMesg) {
        const { requestId } = mesg;
        let retry = false;
        const attempts = await this.statestore.incrAttempt(requestId);
        // Check if we've exceeded attempts
        if (attempts > MAX_ATTEMPTS) {
            return retry;
        }
        // TODO Check connectors retry()
        // Check for agentNot found
        if (errMesg.includes('not found in project')) {
            retry = true;
        }
        if (retry) {
            await this.statestore.setAgentStatus(requestId, RETRY);
            this.callActivationLater(mesg, attempts);
        }
        return retry;
    }

    async _handleAgentError(m, err) {
        const activationId = m.requestId;
        this.logger.debug(`handle agent error ${activationId}`);
        const mutex = new Mutex(this.redis, activationId, {});
        try {
            await mutex.acquire();
            const outputEvent = this._messageToOutputEvent(m);
            let errMsg = m.error;
            if (err instanceof Error) {
                errMsg = err.message;
            } else if (err) {
                errMsg = err;
            }
            _.set(outputEvent, 'message.error', errMsg);
            let response;
            if (m.messageId) {
                await this.statestore.jobMessageError(activationId, _.split(m.messageId, ':')[0]);
            }
            const activationPending = await this.redis.exists(activationId);
            if (!activationPending) {
                // Was waiting for the mutex and someone completed the activation while I was waiting
                console.error('Activation finished before _handleAgentError() completed'); // Should be low frequency occurrence
                return;
            }
            if (m.plan && err?.statusCode !== 404) { // Don't run finally if agent not found
                try {
                    response = await this.finalSkills(m, errMsg, true);
                } catch (finalErr: any) {
                    // Don't throw as I don't want to handleAgentError() again !
                    response = finalErr.message;
                }
            } else {
                response = errMsg;
            }
            const skillsDone = await this.statestore.allTransitsDone(activationId);
            // Can have more than one error with send_message() messages..
            if (skillsDone || !m.messageId) {
                // No retries for send_message() requests..
                // TODO re-enable..
                // await this.handleRetry(m, errMsg);
                await this.statestore.endActivation(activationId, response, new Date().getTime(), ERROR);
            }
            if (m.agent?.trim().length > 0) await this.eventHandler.publishEvent(activationId, 'agent.output', outputEvent);
            await this._handleCallBack(m, response, ERROR);
        } finally {
            await mutex.release();
        }
    }

    /**
     * Execute finally skill, if not defined return response, otherwise return skill response
     * Do both catch/finally
     * @param msg
     * @param payload
     * @param callCatch - boolean call catch normally only during error call path
     * @return {Promise<void>}
     */
    async finalSkills(msg, payload, callCatch = false) {
        let op = 'Catch/finally';
        let response = payload;
        const {
            requestId, username, projectId, sessionId, plan, token,
        } = msg;
        if (!plan) {
            throw Error('no execution plan available for agent');
        }
        try {
            const { output } = plan;
            const secrets = new SecretsClient(token);
            // TODO how do I handle JOBS/Agent invokes ??
            // if I am processing an error call catch
            if (callCatch && output?.catch?.skillName) {
                op = 'Catch';
                const catchReq: any = {
                    requestId,
                    projectId,
                    username,
                    skillName: output.catch.skillName,
                    inputName: undefined,
                    token,
                    sessionId,
                    payload: { error: response },
                    sync: true,
                };
                const catchResp = await this._processSkill(new SynapseMessage(catchReq), {
                    from: 'catch',
                    to: 'catch',
                    type: 'skill',
                    ref: output.catch,
                }, secrets);
                response = catchResp?.outputMsg?.payload ?? {};
            }
            // If defined called finally
            if (output?.finally?.skillName) {
                op = 'Finally';
                const finallyReq: any = {
                    requestId,
                    projectId,
                    username,
                    skillName: output.finally.skillName,
                    inputName: undefined,
                    token,
                    sessionId,
                    payload: response,
                    sync: true,
                };
                const finallyResp = await this._processSkill(new SynapseMessage(finallyReq), {
                    from: 'finally',
                    to: 'finally',
                    type: 'skill',
                    ref: output.finally,
                }, secrets);
                response = finallyResp?.outputMsg?.payload ?? {};
            }
            this.logger.debug(`${op} called successfully`, this._loggerContext(msg));
            return response;
        } catch (err: any) {
            const message = `${op} invoke error: ${err.message}`;
            this.logger.error(message, this._loggerContext(msg));
            throw Error(message);
        }
    }

    // TODO validate error handling for unable to mutex, redis err, callback failed, etc
    /**
     * Complete and update the activation with the response payload.
     * @param m
     * @param agentName
     * @param outputRefParam
     * @param payload
     * @return {Promise<{}|*>}
     * @private
     */
    async _handleAgentOutput(m: SynapseMessage, agentName: string, outputRefParam = undefined, payload = undefined): Promise<{} | any> {
        const activationId = m.requestId;
        this.logger.debug(`handle agent output ${activationId}`);
        // Used to detect messages received from sendMessage()
        const messageChannel = (m?.messageId ?? '').split(':')[0];
        let outputRef: any = outputRefParam;
        // occasionally this might undefined, say for job callbacks/agent callbacks..
        if (outputRefParam === undefined) {
            const { plan } = await this.statestore.getAgentState(activationId);
            outputRef = plan.output;
        }
        if (_.isEmpty(outputRef)) {
            throw Error('Agent output failed: Outputref missing from cache & request');
        }
        const mode = (outputRef?.mode ?? SINGLE).toLowerCase();
        /**
         * Will use the merge key for everything except mode===STATS
         * 1) need to distribute output response in case another GW instance completes the invoke
         * 2) need to collect output if we are merging them
         */
        const mergekey = `${activationId}:${outputRef?.signalId}`;
        // three modes supported SINGLE, STATS, MERGE
        let response: any | undefined = payload;
        if (mode !== STATS && payload !== undefined) {
            // Could be $$$ so don't want to always do this ..
            // This can happen concurrently
            this.redis.rpush(mergekey, JSON.stringify(payload));
        }
        /**
         *  START MUTEX
         *  Only allow one skill in the activation to execute this code...
         */
        const mutex = new Mutex(this.redis, activationId, {});
        try {
            await mutex.acquire(); // TODO move release(s) to a finally block ... makes code clearer..
            // If the redis key for the activation still exist continue
            const activationPending = await this.redis.exists(activationId);
            if (!activationPending) {
                // Was waiting for the mutex and someone completed the activation while I was waiting
                await mutex.release();
                return {};
            }
            // If all the skills are done, we can complete the activation
            const skillsDone = await this.statestore.allTransitsDone(activationId);
            let messagesDone = true;
            // if we are sending messages ( we have a messageChannel defined )
            if (messageChannel) {
                // Track messages completed
                await this.statestore.jobMessageDone(activationId, messageChannel);
                const { received, done, errors } = await this.statestore.getJobMessageStats(activationId, messageChannel);
                // Assuming we've processed all messages sent...
                messagesDone = (done + errors) >= received;
                // Is output has `stats` mode just return the stats collected..
            }
            if (this.logger.debug) {
                this.logger.debug(`Agent output skillsDone: ${skillsDone}, messagesDone: ${messagesDone}, response: ${JSON.stringify(response)}`);
            }
            // All work is done complete the activation
            if (skillsDone && messagesDone) {
                // Collect the response object
                if (mode === MERGE) {
                    // Get all stored payloads and merge them, the payload for the current call is also in redis
                    const rawPayloads = await this.redis.lrange(mergekey, 0, -1);
                    response = rawPayloads.map((p) => parseIfJSON(p)); // Parse these so the final output is valid JSON
                } else if (mode === STATS) {
                    // so messageID will be NULL for final call from task callback in this case the channelId should be correct ...
                    response = await this.statestore.getJobMessageStats(activationId, messageChannel || m.channelId);
                } else if (_.isEmpty(response)) { // If the response is empty, might a job that called send_message(), grab the payload stashed in redis
                    const lastItem = await this.redis.lrange(mergekey, -1, -1);  // This seems imprecise, just grab last one?
                    // parse the JSON so the result is valid JSON ( not JSON encoded string )
                    response = parseIfJSON(lastItem[0]);
                }
                // Figure out the final status
                // Pre 12/10/2023 we'd mark everything as COMPLETE ( assuming nothing failed with a non-zero exit code )
                // POST 12/10/2023 if every transit COMPLETES the activation is COMPLETE
                //
                let agentStatus;
                if (LEGACY_AGENT_COMPLETE) {
                    agentStatus = COMPLETE;
                } else {
                    const transits = await this.statestore.getAllTransits(activationId);
                    agentStatus = transits.every((t) => t.status !== ERROR) ? COMPLETE : ERROR;
                }
                try {
                    // Execute finally skill if it exists and mutate the response
                    response = await this.finalSkills(m, response, false);
                } catch (finalErr: any) {
                    // Catch finally skill errors so we don't reprocess this error in handeAgentError()
                    response = finalErr.message;
                    agentStatus = ERROR;
                }
                const outputEvent = this._messageToOutputEvent(m);
                outputEvent.message.payload = response;
                await Promise.all([
                    this.statestore.endActivation(activationId, response, new Date().getTime(), agentStatus),
                    this._handleCallBack(m, response, agentStatus),
                    // Create agent.output event
                    this.eventHandler.publishEvent(m.requestId, 'agent.output', outputEvent),
                ]);
            }
            return response;
        } finally {
            await mutex.release();
        }
    }

    async _processOutput(mesg: SynapseMessage, step) {
        const transitName = genTransitName(step);
        try {
            await this.statestore.startTransit(mesg.requestId, step.from, step.to, mesg.messageId, transitName);
            const outputPayload = (step?.mapping?.rules ?? []).length > 0 ?
                await this.mapping.executeMapping(mesg.sessionId, mesg?.payload, step.mapping.rules) :
                mesg?.payload;
            await this.statestore.completeTransit(mesg.requestId, step.from, step.to, COMPLETE, mesg.messageId);
            return await this._handleAgentOutput(mesg, mesg.agentName, step.ref, outputPayload);
        } catch (err) {
            await this.statestore.completeTransit(mesg.requestId, step.from, step.to, ERROR, mesg.messageId);
            throw err;
        }
    }

    async _processSkill(mesg: synapseMessage, step, secrets) {
        const transitName = genTransitName(step);
        await this.statestore.startTransit(mesg.requestId, step.from, step.to, mesg.messageId ?? '', transitName);
        const refName = step?.ref?.skillName ?? '';
        try {
            const skillDef = await this.resourceProvider.getSkill(mesg.projectId, refName);
            if (skillDef === undefined) {
                throw boom.notFound(`Skill "${refName}" is NOT deployed`);
            }
            const skill = new Skill(mesg.agentName, step, skillDef, this, secrets);
            if (!_.isEmpty(step.mapping)) {
                // eslint-disable-next-line no-param-reassign
                mesg.payload = await this.mapping.executeMapping(mesg.projectId, mesg.sessionId, mesg.payload, step.mapping);
            }
            const skillResponse = await skill.run(mesg);
            if ((skillResponse.async ?? false) === false) {  // If not async I have finished
                // Async aka jobs will handle transit in task controller.
                await this.statestore.completeTransit(mesg.requestId, step.from, step.to, COMPLETE, mesg.messageId ?? '');
            }
            return skillResponse;
        } catch (err) {
            await this.statestore.completeTransit(mesg.requestId, step.from, step.to, ERROR, mesg.messageId ?? '');
            throw err;
        }
    }

    async _processMessage(message: synapseMessage) {
        const {
            agentName, channelId, outputName, requestId, token,
        } = message;
        // Get status and plan, plan is stored to avoid agent changes during execution..
        const { status, plan } = await this.statestore.getAgentState(requestId);
        // Validate this.
        if (status !== PENDING) {
            return requestId; // Nothing to do here
        }
        if (!message.plan) {
            message.plan = plan;
        }
        // const agent = await this.resourceProvider.getAgent(projectId, agentName);
        const secrets = new SecretsClient(token);
        const { states } = plan;
        try {
            // if output name is no-op dor o-nothing skip it.  this output doesn't require down stream processing
            if (outputName === 'ignore') {
                // MAYBE checkout output here..
                return message.requestId; // Nothing to do here
            }
            let toProcess;
            // this should only be empty on agent input
            if (_.isEmpty(outputName)) {
                toProcess = states.filter((s) => s.from === channelId);
            } else {
                toProcess = states.filter((s) => s.from === channelId && outputName === s.fromOutput);
            }
            if (_.isEmpty(toProcess)) {
                //  This is restrictive but it seems safer to more strictly filter states/edges from nodes..
                await this._handleAgentError(message, Error(`No mapping found for "${channelId}" and output "${outputName}" in agent "${agentName}"`));
            }
            // For each state invoke skill or output
            await Promise.all(toProcess.map(async (step) => {
                try {
                    if (step?.type === 'skill') {
                        const skillResponse = await this._processSkill(message, step, secrets); // returns odd type ??
                        if (skillResponse !== undefined && skillResponse?.async === false) {
                            // IF synchronous go ahead and call next step.
                            await this._processMessage((skillResponse?.outputMsg as SynapseMessage));
                        }
                    } else {
                        await this._processOutput(message, step);
                    }
                } catch (err) {
                    // attempt to complete transit but don't throw if it doesn't exist..
                    await this._handleAgentError(message, err);
                }
            }));
        } catch (err) {
            await this._handleAgentError(message, err);
        }
        return requestId;
    }

    /**
     * Generate the plan for the request and store it with the activation state
     * @param message
     */
    async getPlanForActivation(message: SynapseMessage) {
        let { plan } = await this.statestore.getAgentState(message.requestId);
        if (!plan) {
            // Use agent to create the plan now, don't fetch it again in case it changes while I am running...
            plan = await this.mapping.getPlan(message.projectId, message.agentName, message.serviceName);
            // Store plan with activation, so it doesn't change during execution.
            await this.statestore.storePlan(message.requestId, plan);
        }
        return plan;
    }

    async invokeAgent(message: SynapseMessage) {
        // Rest api already has an activationId, other callers might not ...
        // Filter request header for REST or kafka
        const agent = await this.resourceProvider.getAgent(message.projectId, message.agentName || '');
        // Re-check agent and input name as this could be a non-rest client
        if (agent === undefined) {
            throw boom.notFound(`Agent "${message.agentName}" not found in project ${message.projectId}`);
        }
        try {
            message.headers = getFilteredHeaders(agent?.properties ?? [], message.headers);
            // Must always create an activation to support use cases like kafka/agent invoke as callback
            // won't be process is the is no activation record
            let planError = undefined;
            try {
                const plan = await this.getPlanForActivation(message);
                message.channelId = plan?.input?.signalId;
                message.plan = plan;
            } catch (pErr) {
                planError = pErr;
            } finally {
                // Write activation PENDING to activations
                // Do this now, so we can ensure activation record is always available
                await this.statestore.startActivation(message.requestId, {
                    ...message,
                    agentTitle: agent.title,
                    start: message.timestamp,
                    status: PENDING,
                });
            }
            // Yuck, I wanted to create the activation record, but stop further processing the plan was bad
            if (planError) {
                throw planError;
            }
            // Use agent to create the plan now, don't fetch it again in case it changes while I am running...
            //const plan = await this.getPlanForActivation(message);
            this.eventHandler.publishEvent(message.requestId, 'agent.input', this._messageToOutputEvent(message));
            if (message.sync) {
                await this._processMessage(message);
            } else {
                this.queue.add(async () =>  this._processMessage(message));
                // TODO workers
            }
        } catch (err: any) {
            const errMsg = `Error invoking agent ${message.agentName} input ${message.serviceName}: ${err.message}`;
            this.logger.error(errMsg, this._loggerContext(message));
            await this._handleAgentError(message, err);
        } finally {
            return message.requestId;
        }
    }

    _toNameValue(obj) {
        if (_.isEmpty(obj)) return [];
        return Object.keys(obj)
            .map((k) => ({
            name: k,
            value: obj[k],
        }));
    }

    async endSyncSkillActivation(message: SynapseMessage, resp) {
        // Store activation in state store
        if ((resp?.async ?? false) === false) { // I am done if NOT async
            await this.statestore.endActivation(message.requestId, resp.outputMsg?.payload, new Date().getTime(), COMPLETE);
        }
    }

    async invokeSkill(message: SynapseMessage) {
        const secrets = new SecretsClient(message.token);
        // create initial state
        const activation = {
            ...message,
            channelId: 'output',
            start: new Date().getTime(),
            status: PENDING,
        };

        try {
            await this.statestore.startActivation(message.requestId, activation);
            const step = {
                ref: {
                    skillName: message.skillName,
                    refId: message.channelId,
                    properties: this._toNameValue(message.properties),
                },
                from: message.inputName,
                to: message.channelId,
                toInput: message.inputName,
            };
            // queue is added to limit concurrent promises to avoid stack overflow, thrashing the process
            // a perfect solution would add everything to a queue not just sync=false
            const skillCall = async () => {
                const resp = await this._processSkill(message, step, secrets);
                await this.endSyncSkillActivation(message, resp);
                return resp;
            };
            if (message.sync) {
                return await skillCall();
            } else {
                this.queue.add(skillCall).catch(async (err) => this._handleAgentError(message, err)); // error should be handled
            }
        } catch (err: any) {
            await this._handleAgentError(message, err); // finalize activation..
            throw err;
        }
    }

    async planDiagram(projectId: string, agentName: string, input) {
        const headerLines: string[] = [];
        const agent: any = await this.resourceProvider.getAgent(projectId, agentName);
        if (agent === undefined) {
            throw boom.notFound(`Agent ${agentName} not found`);
        }
        const plan = await this.mapping.genPlan(projectId, agent, input, true); // Always regenerate jic.
        headerLines.push(`digraph "${agent.name}" {`);
        headerLines.push('forcelabels=true;');
        return {
            plan,
            dotNotation: [...headerLines, ...this.mapping.diagramForPlan(plan), '}'].join('\n'),
        };
    }
}
