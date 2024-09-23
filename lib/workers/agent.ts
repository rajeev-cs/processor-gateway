import _ from 'lodash';
import path from 'path';
import 'reflect-metadata'; // inverify annotations need this .
import { Piscina } from 'piscina';
import { isMainThread } from 'node:worker_threads';
import config from 'config';
import { getLogger, toBoolean } from '@tt-sensa/sensa-express-common';
import SynapseMessage from '../models/synapseMessage.js';

const logger = getLogger(config.get('name'), config.get('logging'));

export function startWorkerPool() {
    if (isMainThread && toBoolean(config.features.agent_workers)) {
        logger.warn('Workers enabled, running multiple processes');
        const agentWorkerScript = path.resolve(new URL('./agent.js', import.meta.url).pathname);
        // Setup worker
        const agentWorkerPool = new Piscina({
            filename: agentWorkerScript,
            // TODO expose and define reasonable defaults
            maxQueue: _.toInteger(config.agentWorker.maxQueueSize),
            maxThreads: _.toInteger(config.agentWorker.threads),
            idleTimeout: _.toInteger(config.agentWorker.idleTimeoutMS),
            concurrentTasksPerWorker: _.toInteger(config.agentWorker.concurrency),
        });

        // This allows other agent/skill invokers to queue requests via the work pool
        //invokeChannel.onmessage = (msg) => agentWorkerPool.run(msg);
        // connectors = getConnectors();
        // await Promise.all(Object.values(connectors)
        // .map((c) => {
        //     app.logger.info(`Connector ${c.name} starting`);
        // return c.start(agentWorkerPool);
        // })); // Start consumers..
        return agentWorkerPool;
    }
    return undefined;
}

// TODO just use this file/code to setup s synapse and call in single threaded mode..

async function init() {
    if (isMainThread) return; // Don't run inside main thread
    const { init: dbInit } = await import('../database.js');
    const { Synapse } = await import('../synapse.js');
    const { getStateStore } = await import('../state/stateStore.js');
    const { RuntimeProvider } = await import('../actions/runtimeProvider.js');
    const infra = await dbInit({ logger });
    const runtimeProvider = new RuntimeProvider(infra);
    const stateStore = getStateStore(infra);
    // Needed for handleCallbacks + producer
    // TODO const connectors = getConnectors();
    const synapse = new Synapse(infra, stateStore, runtimeProvider); // TODO connectors
    logger.info('Agent worker ready');
    return (msg) => synapse.invokeAgent(new SynapseMessage(msg));
}

// This is needed for async infra for workers (https://github.com/piscinajs/piscina#delaying-availability-of-workers)
export default init();
