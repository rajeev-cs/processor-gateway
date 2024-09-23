import { ResponseBase } from './BaseTypes.js';

export interface InvokeRequest {
    sessionId?: string,
    payload?: { [key:string]:any; },
    properties?: { [key:string]:any; },
    correlationId?: string
}

export interface InvokeResponse extends ResponseBase {
    activationId: string,
    response?: { [key:string]:any; },
}

export interface PlanDiagramResponse extends ResponseBase {
    plan?: any,
    diagram?: string,
}

export interface ActivationListResponse extends ResponseBase {
    activations?: any;
}

export interface ActivationResponse extends ResponseBase {

}
