/* eslint-disable @typescript-eslint/no-unused-vars */
import * as express from 'express';
import { inject, injectable } from 'inversify';
import _ from 'lodash';
import {
    Body,
    Controller,
    Get, Hidden,
    Path,
    Post,
    Query, Request,
    Res,
    Route,
    Security,
    SuccessResponse,
    Tags,
} from 'tsoa';
import {
    ActivationListResponse,
    ActivationResponse,
    InvokeRequest,
    InvokeResponse,
    PlanDiagramResponse,
} from '../interfaces/AgentTypes.js';
import { ResponseBase } from '../interfaces/BaseTypes.js';
import { Infra } from '../interfaces/Infra.js';

import * as boom from '@hapi/boom';
import { TsoaResponse } from '@tsoa/runtime';
import { TaskStatusResponse } from '../interfaces/TaskTypes.js';
import { SynapseState } from '../models/synapseState.model.js';
import { Synapse } from '../synapse.js';
import { nativeOmit, parseJson } from '../utils.js';
import agentCtlFn from './agents.js';
import { TaskCtrl } from './tasks.js';

@injectable()
@Route('/fabric/v4')
export class AgentController extends Controller {
    private agentCtl;

    constructor(
        @inject(Infra) private infra: Infra,
        @inject(Synapse) private synapse,
        @inject(TaskCtrl) private taskCtrl: TaskCtrl,
    ) {
        super();
        this.agentCtl = agentCtlFn(infra, synapse, taskCtrl);
    }

    /**
     * Invoke agent service
     * @summary Invoke and agent's service asynchronously, returns an activationId
     * @param projectId - project
     * @param agentName - agent name
     * @param serviceName - service to invoke
     * @param sync - true|false execute synchronously if supported (default: false)
     * @param scheduleCron - Schedule Agent invocation to repeat on each cron interval
     * @param scheduleName - Name of schedule (default: `agentName`)
     */
    @Tags('Agents')
    @Post('/projects/{projectId}/agentinvoke/{agentName}/services/{serviceName}')
    @Security('BearerAuth', ['execute:agents:${params.agentName}'])
    @SuccessResponse(200)
    public async invokeAgent(
        @Request() request: express.Request,
        @Path() projectId: string,
        @Path() agentName: string,
        @Path() serviceName: string,
        @Body() payload: InvokeRequest,
        @Query() sync?: boolean,
        @Query() scheduleCron?: string,
        @Query() scheduleName?: string,
    ): Promise<InvokeResponse> {
        return this.agentCtl.invokeAgent(request, sync);
    }

    /**
     * Get agent service execution plan
     * @summary Get agent service execution plan and diagram in dot notation
     */
    @Tags('Agents')
    @Get('/projects/{projectId}/agentinvoke/{agentName}/services/{serviceName}/diagram')
    @Security('BearerAuth', ['read:agents:${params.agentName}'])
    @SuccessResponse(200)
    public async agentPlanDiagram(
        @Path() projectId: string,
        @Path() agentName: string,
        @Path() serviceName: string,
    ): Promise<PlanDiagramResponse> {
        return this.agentCtl.agentPlanDiagram(projectId, agentName, serviceName);
    }

    /**
     * Invoke skill
     * @summary Invoke and skill asynchronously, returns an activationId
     * @param projectId - project
     * @param skillName - skill name
     * @param inputName - skill input to invoke
     * @param sync - true|false execute synchronously if supported (default: false)
     */

    @Tags('Skills and Actions')
    @Post('/projects/{projectId}/skillinvoke/{skillName}/inputs/{inputName}')
    @Security('BearerAuth', ['execute:skills:${params.skillName}'])
    @SuccessResponse(200)
    public async invokeSkill(
        @Request() request: express.Request,
        @Res() response: TsoaResponse<200, InvokeResponse>,
        @Path() projectId: string,
        @Path() skillName: string,
        @Path() inputName: string,
        @Body() body: InvokeRequest,
        @Query() sync: boolean = false,
    ): Promise<InvokeResponse> {
        // This needs `response` as it return different error code with a custom response message
        // Pass `sync`  here as the TSOA will have parsed/validated it for me..
        return this.agentCtl.invokeSkill(request, response, sync);
    }

    /**
     * List activations in a project
     * @summary List agent and skill activations/ecxecutions
     */
    @Tags('Agent and Skill Activations')
    @Get('/projects/{projectId}/activations')
    @Security('BearerAuth', ['read:activations'])
    @SuccessResponse(200)
    public async listActivations(
        @Path() projectId: string,
        @Query() filter?: string,
        @Query() limit?: number,
        @Query() skip?: number,
        @Query() sort?: string,
        @Request() request?: express.Request,
    ): Promise<ActivationListResponse> {
        // Allow for legacy query params that are NOT in filter
        // Filter overwrites query
        let legacyFilter = {};
        try {
            const query = request?.query ? nativeOmit(request.query, 'filter', 'sort', 'limit', 'skip', 'sort') : {};
            const filterObj = parseJson(filter || {});
            legacyFilter = { ...query, ...filterObj };
        } catch (err) {
            throw boom.badRequest('Invalid query params, filter must be a valid json string', { details: 'filter must be a valid JSON string' });
        }

        return this.agentCtl.listActivations(projectId, {
            filter: legacyFilter, limit, skip, sort,
        });
    }

    /**
     * Get activation by activationId and project
     * @summary Get activationId and project
     */
    @Tags('Agent and Skill Activations')
    @Get('/projects/{projectId}/activations/{activationId}')
    @Security('BearerAuth', ['read:activations'])
    @SuccessResponse(200)
    public async getActivation(
        @Path() projectId: string,
        @Path() activationId: string,
        @Query() verbose?: string,
        @Query() report?: string,
    ): Promise<ActivationResponse> {
        return this.agentCtl.getActivation(projectId, activationId, verbose, report);
    }

    /**
     * Cancel activation by activationId and project
     * @summary Cancel activationId and stop inflight jobs
     */
    @Tags('Agent and Skill Activations')
    @Post('/projects/{projectId}/activations/{activationId}/cancel')
    @Security('BearerAuth', ['execute:activations'])
    @SuccessResponse(200)
    public async cancelActivation(
        @Path() projectId: string,
        @Path() activationId: string,
        @Query() inFlight: boolean = false,
    ): Promise<ResponseBase> {
        return this.agentCtl.cancelActivation(projectId, activationId, inFlight);
    }

    /**
     * Get activation by agent name and activationId
     * @summary Get agent's activations
     */
    @Tags('Agent and Skill Activations', 'Agents')
    @Get('/projects/{projectId}/agentinvoke/{agentName}/activations/{activationId}')
    @Security('BearerAuth', ['read:activations'])
    @SuccessResponse(200)
    public async getActivationByAgent(
        @Path() projectId: string,
        @Path() agentName: string,
        @Path() activationId: string,
    ): Promise<ActivationResponse> {
        return this.agentCtl.getActivation(projectId, activationId);
    }

    /**
     * List activation by agent name
     * @summary List activations by agent name
     */
    @Tags('Agent and Skill Activations', 'Agents')
    @Get('/projects/{projectId}/agentinvoke/{agentName}/activations')
    @Security('BearerAuth', ['read:activations'])
    @SuccessResponse(200)
    public async listActivationByAgent(
        @Path() projectId: string,
        @Path() agentName: string,
        @Query() filter?: any,
        @Query() limit?: number,
        @Query() skip?: number,
        @Query() sort?: string,
    ): Promise<ActivationListResponse> {
        filter.agentName = agentName; // TODO validate
        return this.agentCtl.agentPlanDiagram(projectId, {
            filter, limit, skip, sort,
        });

    }

    /**
     * get task status by task resouce name,
     * @summary Status of task by fabricResource
     */
    @Tags('Agents')
    @Get('/projects/{projectId}/agents/{agentName}/status')
    @Security('BearerAuth', ['read:tasks'])
    @SuccessResponse(200)
    public async agentStatus(
        @Path() projectId: string,
        @Path() agentName: string,
    ): Promise<TaskStatusResponse> {
        const synapseQuery = {
            'state.projectId': projectId,
            'state.agentName': agentName,
        };
        const synapseRes = await SynapseState.findOne(synapseQuery).sort({ 'state.end': -1 });

        const getNodeTitle = (id: string) => synapseRes.plan.nodes[id]?.title || synapseRes.plan.nodes[id]?.name;
        const blocks = synapseRes?.transits?.reduce((acc, curr) => {
            acc[`${getNodeTitle(curr.from)} -  ${getNodeTitle(curr.to)}`] = curr.status;

            return acc;
        }, {});

        return {
            status: _.get(synapseRes, ['state', 'status'], 'Not Found'),
            startTime: _.get(synapseRes, ['state', 'start'], ''),
            endTime: _.get(synapseRes, ['state', 'end'], ''),
            resourceName: agentName,
            success: true,
            blocks,
        };
    }

    /**
     * Internal test endpoint
     */
    @Hidden()
    @Tags('Test')
    @Get('/echo')
    @SuccessResponse(200)
    public async echo(): Promise<ResponseBase> {
        return { success: true, message: 'echo' };
    }
}

// FIXME add agent stop/cancel
// FIXME list "running" agent invokes
