import http from 'k6/http';
import { check } from 'k6';

// export const options = {
//   discardResponseBodies: true,
//   // Key configurations for breakpoint in this section
//   executor: 'ramping-arrival-rate', //Assure load increase if the system slows
//   stages: [
//     { duration: '60s', target: 300 }, // just slowly ramp-up to a HUGE load
//   ],
// };

export const options = {
  discardResponseBodies: true,
  thresholds: {
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
    const url = `${__ENV.CORTEX_URL}/myapi`;
    const payload = JSON.stringify({"token":"XXXXXXXXXXXXXXXXXXXXXXX","apiEndpoint":"http://localhost:3000","payload":{"text":"sw in Message"},"activationId":"myactivation","channelId":"chanelId","projectId":"myproject"});
    const params = { headers: { authorization: `bearer ${__ENV.CORTEX_TOKEN}`, 'content-type': 'application/json'}};
    const res = http.post(url, payload, params)
    check(res, {
      'is status 200': (r) => r.status === 200,
      // can't use with discardResponseBodies
      //'check for response': (r) => r.json().response !== undefined,
    });
  }
