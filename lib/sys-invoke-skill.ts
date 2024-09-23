// eslint-disable-next-line import/no-unresolved
import got from 'got';
import path from 'path';
/**
 * This is a standalone script used to headlessly invoke agents, this is primarily used by agent schedules executions.
 *
 * Params example
 '{
 "activationId":"2a3c027c-90e6-444f-be9e-eddb3692d70f",
 "agentName":"",
 "apiEndpoint":"http://cortex-internal.cortex.svc.cluster.local",
 "channelId":"output",
 "outputName":"result",
 "payload":{},
 "projectId":"bptest",
 "properties":{},
 "sessionId":"2a3c027c-90e6-444f-be9e-eddb3692d70f",
 "skillName":"bptest-synthetic-generator",
 "timestamp":1656612475792,
 "token":"",
 // cron task injects these...
 "scheduleName:""
 "serviceName:""
 }'
 */
async function invoke(params) {
    const {
 projectId, apiEndpoint, token, sessionId, agentName, payload, 
    //  headers, // TODO headers..
    scheduleName, serviceName, 
} = params;
    const invokeUrl = path.join(apiEndpoint, '/fabric/v4/projects', projectId, 'agentinvoke', agentName, 'services', serviceName);
    try {
        return await got.post(invokeUrl, {
            headers: {
                Authorization: `bearer ${token}`,
            },
            json: {
                correlationId: scheduleName,
                sessionId,
                payload,
            },
        })
            .json();
    } catch (err) {
        console.error(`Non-2xx response: ${err.response.body}`);
        process.exit(1);
    }
    return '';
}
// Main function
(async () => {
    try {
        const params = JSON.parse(process.argv[2]);
        const resp = await invoke(params);
        console.log(resp);
    } catch (err) {
        console.error(`Invalid job params argument: ${err.message}`);
        process.exit(1);
    }
})();
