import { ResponseBase } from './BaseTypes.js';

interface SessionListItem {
    sessionId: string,
    ttl: number,
    description: string
}

interface ListSessionsResponse extends ResponseBase {
    sessions?: SessionListItem[],
}

interface CreateSessionReq {
    sessionId?: string,
    ttl?: number,
    description?: string,
    state?: { [key:string]:any; },
}

interface GetSessionResponse extends ResponseBase {
    state?: any,
    ttl?: string,
    description?: string,
}

export {
    GetSessionResponse,
    CreateSessionReq,
    SessionListItem,
    ListSessionsResponse,
};
