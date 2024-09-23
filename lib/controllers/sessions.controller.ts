import {
    Body,
    Controller,
    Delete,
    Get,
    Path,
    Post,
    Query,
    Route,
    Security,
    SuccessResponse,
    Tags,
} from 'tsoa';
import { injectable, inject } from 'inversify';
import { Infra } from '../interfaces/Infra.js';
import { ResponseBase } from '../interfaces/BaseTypes.js';
import {
    ListSessionsResponse,
    GetSessionResponse,
    CreateSessionReq,
} from '../interfaces/SessionTypes.js';
import sessionCtlFn from './sessions.js';

@injectable()
@Route('/fabric/v4')
export class SessionController extends Controller {
    private sessionCtl;

    constructor(@inject(Infra) private infra: Infra) {
        super();
        this.sessionCtl = sessionCtlFn(infra);
    }

    /**
     * List sessions by projectId
     * sdsdsdsd
     * dsd
     * ssdsdsds
     * @summary List sessions by project
     */
    @Tags('Sessions')
    @Get('/projects/{projectId}/sessions')
    @Security('BearerAuth', ['read:sessions'])
    @SuccessResponse(200)
    public async listSessions(
        @Path() projectId: string,
        @Query() limit?: number,
    ): Promise<ListSessionsResponse> {
        return this.sessionCtl.listSessions(projectId, { limit });
    }

    /**
     * Get session state by projectId and sessionId
     * @summary Get session state
     */
    @Tags('Sessions')
    @Get('/projects/{projectId}/sessions/{sessionId}')
    @Security('BearerAuth', ['read:sessions'])
    @SuccessResponse(200)
    public async getSession(
        @Path() projectId: string,
        @Path() sessionId: string,
        @Query() subKey?: string,

    ): Promise<GetSessionResponse> {
        return this.sessionCtl.getSessionRequest(projectId, sessionId, subKey);
    }

    /**
     * Create session in project
     * @summary Start a new session for the provided sessionId, use this to set a default ttl for all values
     */
    @Tags('Sessions')
    @Post('/projects/{projectId}/sessions')
    @Security('bearerAuth', ['write:sessions'])
    @SuccessResponse(200)
    public async createSession(
        @Path() projectId: string,
        @Body() body: CreateSessionReq,
    ): Promise<GetSessionResponse> {
        return this.sessionCtl.startSession(projectId, body);
    }

    /**
     * Update sessions state by projectId and sessionId
     * @summary Update session state with new values, key values are merged
     */
    @Tags('Sessions')
    @Post('/projects/{projectId}/sessions/{sessionId}')
    @Security('BearerAuth', ['read:sessions'])
    @SuccessResponse(200)
    public async updateSession(
        @Path() projectId: string,
        @Path() sessionId: string,
        @Body() state: any,
    ): Promise<GetSessionResponse> {
        return this.sessionCtl.postSessionData(projectId, sessionId, state);
    }

    /**
     * Delete session by projectId and sessionId
     * @summary Delete session by sessionId
     */
    @Tags('Sessions')
    @Delete('/projects/{projectId}/sessions/{sessionId}')
    @Security('BearerAuth', ['write:sessions'])
    @SuccessResponse(200)
    public async deleteSession(
        @Path() projectId: string,
        @Path() sessionId: string,
    ): Promise<ResponseBase> {
        return this.sessionCtl.deleteSession(projectId, sessionId);
    }
}
