import _ from 'lodash';
import config from 'config';
import { sanitizeName } from '@tt-sensa/sensa-express-common/k8s.js';
import * as Boom from '@hapi/boom';
import * as cron from 'cron-validator';
import * as ctx from '@tt-sensa/sensa-express-common/express-context.js';

/**
 * Moved some standalone functions here to avoid dep issues.
 */

// external URL for job to call fabric apis
const cortexUrl = config.services.api.endpoint;
// internal URL controller will use this to call gateway

// TODO this needed still ?
const callbackUrlBase = config.services.callback.endpoint;

export function     createK8sTask({
                                  name, actionName, activationId, projectId, serviceName, skill, channelId, params, token, taskPoolName, outputName, action, schedule,
                              }) {
    const username = ctx.get('username');
    // Skill might be in another project for example shared skill, if not array use provided projectId
    const labels = {
        'fabric.activationId': activationId, // Not available for scheduled jobs
        'fabric.jobtype': 'invoke',
        'fabric.project': projectId,
        'fabric.source': config?.name,
    };
    const annotations = {
        'fabric.actionName': actionName,
        'fabric.skillName': params?.skillName, // use original skillname not k8s one
        'fabric.agentName': params.agentName,
        'fabric.username': username,
    };
    const taskResource = {
        apiVersion: 'fabric.cognitivescale.com/v1',
        kind: 'Task',
        metadata: {
            annotations,
            labels,
        },
        // Task id can be the k8s generated job name
        spec: {
            actionName: sanitizeName(actionName),
            activationId,
            // This allows controller to notify gateway the task is complete.. and pass stdout if needed
            // if the job code calls this the output is ignored but it will trigger the next skill if on exist
            cortexUrl,
            // BAD NAME here ... This is { properties, token, payload, apiUrl, ... }
            payload: JSON.stringify(params || {}),
            skillName: skill.name, // Use K8s skill name so we can locate skill resource
            skillOutputName: outputName,
            taskPoolName: taskPoolName || 'default',
            jobTimeout: action?.jobTimeout ?? 0,
            token,
        },
    };
    // Use service name + generate name UNLESS name is provided.
    if (name === undefined) {
        _.set(taskResource, 'metadata.generateName', `${serviceName}-`);
    } else {
        _.set(taskResource, 'metadata.name', name);
    }
    // TODO callback not needed anymore.. remove?
    if (activationId !== undefined) _.set(taskResource, 'spec.callbackUrl', `${callbackUrlBase}/internal/tasks/${activationId}/${channelId}`);
    if (schedule !== undefined) _.set(taskResource, 'spec.schedule', schedule);
    return taskResource;
}

const ValidCronShortcuts = ['@annually', '@hourly', '@daily', '@monthly', '@midnight', '@weekly', '@yearly', '@every'];

export function validateCron(cronStr) {
    if (cronStr.startsWith('@')) {
        if (cronStr.startsWith('@every')) {
            const [, duration] = cronStr.split(' ');
            if (!/^(\d+[hms])+$/i.test(duration)) {
                throw Boom.badRequest(`Invalid cron duration in "${cronStr}", only h (hours), m (minutes), or s (seconds) are allowed `);
            }
            return true;
        }
        if (!ValidCronShortcuts.some((s) => _.toLower(cronStr) === s)) {
            throw Boom.badRequest(`Invalid cron pre-defined schedule "${cronStr}", valid options are ${ValidCronShortcuts.join(',')}`);
        }
        return true;
    }
    if (!cron.isValidCron(cronStr, {
        alias: true,
        allowBlankDay: true,
        seconds: false,
        allowSevenAsSunday: false,
    })) {
        throw Boom.badRequest(`Invalid cron string "${cronStr}"`);
    }
    return true;
}
