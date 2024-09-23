import {
    Controller,
    Get,
    Path,
    Delete,
    Body,
    Hidden,
    Route,
    Request,
    SuccessResponse,
    Tags, Post,
} from 'tsoa';
import * as boom from '@hapi/boom';
import { inject, injectable } from 'inversify';
import cluster from 'node:cluster';
import { ResponseBase } from '../interfaces/BaseTypes.js';
import { TaskCtrl } from './tasks.js';
import { Infra } from '../interfaces/Infra.js';
import { Synapse } from '../synapse.js';
import { ResourceProvider } from '../clients/resourceProvider.js';
import { COMMAND_CACHE_UPDATE, COMMAND_CHANNEL } from '../events/socketEventHandler.js';
import { SynapseState } from '../models/synapseState.model.js';

@Hidden()
@Tags('Internal')
@injectable()
@Route('/internal')
export class InternalController extends Controller {
    private resourceProvider: ResourceProvider;

    private taskCtl: TaskCtrl;

    constructor(
        @inject(Infra) private infra: Infra,
        @inject(Synapse) private synapse,
        @inject(TaskCtrl) private taskCtrl: TaskCtrl,
    ) {
        super();
        this.taskCtl = taskCtrl;
        this.resourceProvider = synapse.resourceProvider;
    }

    @Get('stats')
    @SuccessResponse(200)
    public async getStats(
    ): Promise<any> {
        const agentWorkerPool = this.infra.workerPool;
        return ({
            workerCount: Object.keys(cluster.workers).length,
            agentWaitTime: agentWorkerPool.waitTime,
            agentRunTime: agentWorkerPool.runTime,
            agentThreads: agentWorkerPool.threads,
            agentQueueSize: agentWorkerPool.queueSize,
            agentInvokeCount: agentWorkerPool.completed,
        });
    }

    /**
     * Delete all activations from mongo
     */
    @Get('clearActivations')
    @SuccessResponse(200)
    public async clearActivations(
    ): Promise<any> {
        return SynapseState.deleteMany({});
    }

    @Post('/clearcache')
    @SuccessResponse(200)
    public async clearCache(): Promise<any> {
        // Notify other GWS
        this.infra.redis.publish(COMMAND_CHANNEL, JSON.stringify({ command: COMMAND_CACHE_UPDATE, op: 'clear' }));
        return this.resourceProvider.clearAll();
    }

    /**
     * List resources in cache by type
     * @summary Debug end point for listings cached resources by type
     */
    @Get('/resources/{type}/')
    @SuccessResponse(200)
    public async listResourceByType(
        @Path() type: string,
    ): Promise<any> {
        return this.resourceProvider.list(type);
    }

    @Get('/{projectId}/resources/{type}/{name}')
    @SuccessResponse(200)
    public async getResource(
        @Path() type: string,
        @Path() projectId: string,
        @Path() name: string,
    ): Promise<any> {
        const decodeName = decodeURIComponent(name);
        if (type.startsWith('agent')) {
            return this.resourceProvider.getAgent(projectId, decodeName);
        }
        if (type.startsWith('skill')) {
            return this.resourceProvider.getSkill(projectId, decodeName);
        }
        throw boom.badRequest(`Unsupported type "${type}`);
    }

    /**
     * Upsert resource with provided k8s resource
     * @param type
     * @param projectId
     */
    @Post('/resources/{type}')
    @SuccessResponse(200)
    public async upsertResource(
        @Path() type: string,
        @Body() resource: any,
    ): Promise<string> {
        // Notify other GWS
        this.infra.redis.publish(COMMAND_CHANNEL, JSON.stringify({ command: COMMAND_CACHE_UPDATE, op: 'update', resourceType: type, resource }));
        return this.resourceProvider.update(type, resource);
    }

    /**
     * Upsert resource with provided k8s resource
     * @param type
     * @param projectId
     */
    @Delete('/resources/{type}')
    @SuccessResponse(200)
    public async deleteResource(
        @Path() type: string,
        @Body() resource: any,
    ): Promise<string> {
        this.infra.redis.publish(COMMAND_CHANNEL, JSON.stringify({ command: COMMAND_CACHE_UPDATE, op: 'delete', resourceType: type, resource }));
        return this.resourceProvider.delete( type, resource);
    }

    @Post('/tasks/{activationId}/{channelId}')
    @Path('activationId')
    @Path('channelId')
    @SuccessResponse(200)
    public async taskCallback(
        @Request() request: Request,
    ): Promise<ResponseBase> {
        return this.taskCtl.taskCallBack(request);
    }


    //TODO make an interface...
    @Post('/tasks')
    @SuccessResponse(200)
    public async storeTask(
        @Request() request: Request,
    ): Promise<ResponseBase> {
        return this.taskCtl.storeTask(request);
    }

    @Post('/messages/{activationId}/{channelId}/{outputName}')
    @Path('activationId')
    @Path('channelId')
    @Path('outputName')
    @SuccessResponse(200)
    public async handleMessage(
        @Request() request: Request,
    ): Promise<ResponseBase> {
        return this.taskCtl.handleMessage(request);
    }
}
