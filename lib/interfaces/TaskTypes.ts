import { ResponseBase } from './BaseTypes.js';

export interface TaskListResponse extends ResponseBase {
    tasks?: any;
}

export interface TaskResponse extends ResponseBase {
    task?: any;
}

export interface TaskLogsResponse extends ResponseBase {
    logs?: string[];
}

export interface TaskStatusResponse extends ResponseBase {
    status: string;
    startTime?: string;
    endTime?: string;
    resourceType?: string;
    resourceName: string;
    blocks?: Record<string, string>;
}

export enum ResourceTypes {
    DataSource = 'datasource',
    Profile = 'profile',
    Pipeline = 'pipeline',
    ManagedContent = 'content',
    Connection = 'connection',
}