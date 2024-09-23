import http from 'k6/http';
import { check } from 'k6';

export const options = {
//  discardResponseBodies: true,
  thresholds: {
    // Gather http code JIC
    // Some dummy thresholds that are always going to pass.
    'http_req_duration{status:200}': ['max>=0'],
    'http_req_duration{status:401}': ['max>=0'],
    'http_req_duration{status:403}': ['max>=0'],
    'http_req_duration{status:404}': ['max>=0'],
    'http_req_duration{status:500}': ['max>=0'],
    'http_req_duration{status:503}': ['max>=0'],
  },
  summaryTrendStats: ['min', 'med', 'avg', 'p(90)', 'p(95)', 'max', 'count'],
  scenarios: {
    contacts: {
      executor: 'ramping-arrival-rate',

      // Start iterations per `timeUnit`
      startRate: 300,

      // Start `startRate` iterations per minute
      timeUnit: '1s',

      // Pre-allocate necessary VUs.
      preAllocatedVUs: 400,
      stages: [
        // Start 300 iterations per `timeUnit` for the first minute.
        { target: 300, duration: '5m' },

        // // Linearly ramp-up to starting 600 iterations per `timeUnit` over the following two minutes.
        // { target: 600, duration: '2m' },
        //
        // // Continue starting 600 iterations per `timeUnit` for the following four minutes.
        // { target: 600, duration: '4m' },
        //
        // // Linearly ramp-down to starting 60 iterations per `timeUnit` over the last two minutes.
        // { target: 60, duration: '2m' },
      ],
    },
  },
};

  export default function () {
    const urlInvoke = `${__ENV.CORTEX_URL}/fabric/v4/projects/${__ENV.CORTEX_PROJECT}/agentinvoke/simple-daemon/inputs/input?sync=true`;
    const payload = JSON.stringify({ payload: { text: "test1234"}});
    const params = { headers: { authorization: `bearer ${__ENV.CORTEX_TOKEN}`, 'content-type': 'application/json'}};
    const resInvoke = http.post(urlInvoke, payload, params)
    check(resInvoke, {
      'is status 200': (r) => r.status === 200,
      // can't use with discardResponseBodies
      'check for response': (r) => r.json().activationId !== undefined,
    });

    // This may have timing issues..  so primarily a check to see if activation exists
    const urlActivation = `${__ENV.CORTEX_URL}/fabric/v4/projects/${__ENV.CORTEX_PROJECT}/activations/${resInvoke.json().activationId}`;
    const resActivation = http.get(urlActivation, payload, params)
    check(resActivation, {
      'is status 200': (r) => r.status === 200,
      // can't use with discardResponseBodies
      'check for response': (r) => r.json().response !== undefined,
    });

  }
