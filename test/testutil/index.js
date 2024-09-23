/* eslint-disable @typescript-eslint/no-unused-expressions */
import chai from 'chai';
import { setTimeout } from 'timers/promises';
import { Logger } from '@tt-sensa/sensa-express-common';

/**
 * Wait until the function `func` returns true. The `func` will be called
 * repeatedly on an interval specified by `options.intervalMs` until
 * it returns `true` or the timeout specified by `options.timeoutMs` expires.
 *
 * NOTES:
 *   - `options` is an object of the form: `{ timeoutMs: Number, intervalMs: Number }`
 *   - `options.timeoutMs` defaults to 10000.
 *   - `options.intervalMs` defaults to 1000.
 *
 * @param {Function} func Function to be called. Must be awaitable.
 * @param {Object} options Properties that modify default behavior.
 * @returns `true` If `func` returned `true`, or `false` if timeout expired.
 */
export async function waitUntil(func, options) {
    const start = new Date();
    const optionsTmp = options || {};
    if (!optionsTmp.timeoutMs) optionsTmp.timeoutMs = 10000;
    if (!optionsTmp.intervalMs) optionsTmp.intervalMs = 1000;
    let done = false;
    while (!done) {
        // eslint-disable-next-line no-await-in-loop
        if (await func()) return true;
        // eslint-disable-next-line no-await-in-loop
        await setTimeout(optionsTmp.intervalMs);
        const elapsed = new Date() - start;
        done = elapsed > optionsTmp.timeoutMs;
    }
    return false; // timed out
}
export function mockLogger(on = true) {
    const logger = new Logger({
        level: 5, consoleOnly: true, disableAudit: true, directory: '.',
    });
    // eslint-disable-next-line no-console
    const log = (level, msg) => {
        if (on) {
            // eslint-disable-next-line no-console
            console.log(`${level}: ${JSON.stringify(msg)}`);
        }
    };
    logger.error = (msg) => log('error', msg);
    logger.warn = (msg) => log('warn', msg);
    logger.log = log;
    logger.debug = (msg) => log('debug', msg);
    logger.info = (msg) => log('info', msg);
    return logger;
}
export function checkResponse(res, statusCode = 200, successFlag = true) {
    // expect invoke to happen
    chai.expect(res.statusCode).to.be.equal(statusCode, res._getData ? res._getData() : res.text);
    const body = res._getJSONData ? res._getJSONData() : JSON.parse(res.text);
    if (successFlag) chai.expect(body).to.have.haveOwnProperty('success');
    if (statusCode !== 200) {
        chai.expect(body)
            .to
            .have
            .property('message');
        // eslint-disable-next-line no-unused-expressions
        if (successFlag) chai.expect(body)
            .to
            .have
            .property('success').false;
    }
    return body;
}

export function getToken() {
    // eslint-disable-next-line max-len
    return 'eyJraWQiOiJfM1g1aWpvcGdTSm0tSmVmdWJQenh5RS1XWGw3UzJqSVZDLXRNWnNiRG9BIiwiYWxnIjoiRWREU0EifQ.eyJiZWFyZXIiOiJ1c2VyIiwiaWF0IjoxNjYxODk4ODE2LCJleHAiOjE2NjE5ODUyMTYsInJvbGVzIjpbImNvcnRleC1hZG1pbnMiXSwic3ViIjoiY29ydGV4QGV4YW1wbGUuY29tIiwiYXVkIjoiY29ydGV4IiwiaXNzIjoiY29nbml0aXZlc2NhbGUuY29tIn0.laOqBSh06UeoUm8utNt2Fw4GtRpOu9PFIDoozBhWo9oOoy-O-E2pAROUbIf-P6vW76GUQFK9DHd7IywhKjcTDA';
}

export function  getAuthHeader() {
    return `bearer ${getToken()}`;
}
