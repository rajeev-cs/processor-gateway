import _ from 'lodash';
import { isMainThread } from 'node:worker_threads';
import config from 'config';
import { glob } from 'glob';
import mongoose from 'mongoose';
import { getNamespace, K8SClient, K8SRESOURCES, tok8sName } from '@tt-sensa/sensa-express-common/k8s.js';
import { Migrater, parseIfJSON } from '@tt-sensa/sensa-express-common';
import { Redis } from 'ioredis';
import fs from 'fs';
import yaml from 'js-yaml';
// eslint-disable-next-line import/no-unresolved
import got from 'got';
import { container } from './ioc.js';
import { updateHealth } from './controllers/healthController.js';
import { createEventHandler } from './events/handler.js';
import { StateStore } from './state/abstractStateStore.js';
import { getStateStore } from './state/stateStore.js';
import { Infra } from './interfaces/Infra.js';
import { startWorkerPool } from './workers/agent.js';
import { getResourceProvider } from './clients/resources.js';
import { getThreadName } from './utils.js';

const SHARED_PROJECT = config.resources.shareProject;

function parse(a) {
    return _.isString(a) ? JSON.parse(a) : a;
}

async function getInvokeJobImage() {
    if (!_.isEmpty(config.kubernetes.invokeImage)) {
        return config.kubernetes.invokeImage;
    }
    const sa = '/var/run/secrets/kubernetes.io/serviceaccount';
    const nsFile = `${sa}/namespace`;
    const tokenFile = `${sa}/token`;
    if (fs.existsSync(nsFile) && fs.existsSync(tokenFile)) {
        const namespace = fs.readFileSync(nsFile);
        const token = fs.readFileSync(tokenFile);
        const certificateAuthority = fs.readFileSync(`${sa}/ca.crt`);
        const pod: any = await got(`https://kubernetes.default.svc/api/v1/namespaces/${namespace}/pods/${process.env.HOSTNAME}`, {
            https: { certificateAuthority },
            headers: { Authorization: `bearer ${token}` },
        })
            .json();
        const gwContainer = (pod?.spec?.containers ?? [])
            .find((c) => c.name === 'cortex-processor-gateway');
        return gwContainer?.image;
    }
    throw Error(`Serviceaccount not available in pod (${getThreadName()})`);
}

async function createSystemSkill({ logger, k8sClient }) {
    const skillsFiles = glob.sync('./data/skills/**/*.+(yaml|json|yml)');
    // get image to use to agent invoke job.
    let invokeImage;
    try {
        invokeImage = await getInvokeJobImage();
        logger.info(`Gateway invoke image (${getThreadName()}): ${invokeImage}`);
    } catch (err) {
        logger.error(`Unable to get gw image from container, set INVOKE_IMAGE env var with GW image (${getThreadName()}): ${err.message}`);
    }
    await Promise.all(skillsFiles.map(async (s) => {
        try {
            const stats = fs.statSync(s);
            const currentVersion = `${Math.ceil(stats.mtimeMs / 60000)}`; // File timestamp in minutes
            const currentSkill: any = yaml.load(fs.readFileSync(s).toString());
            const currentImage = await getInvokeJobImage();
            const skillName = tok8sName(SHARED_PROJECT, currentSkill?.metadata?.name);
            let foundSkill;
            if (process.env.NODE_ENV !== 'test') {
                try {
                    foundSkill = await k8sClient.getResource(K8SRESOURCES.SKILL, skillName, getNamespace());
                } catch (err) {
                    if (err?.response?.statusCode !== 404) {
                        throw err;
                    }
                }
            }
            // check for update ?
            const foundVersion = foundSkill?.metadata?.labels?.['fabric.skill-version'];
            const foundImage = foundSkill?.spec?.actions?.[0]?.podSpec?.containers?.[0]?.image;
            // console.log('CHECK', { foundSkill: JSON.stringify(foundSkill), foundVersion, currentVersion, foundImage, currentImage });
            if (foundSkill === undefined || (foundVersion !== currentVersion || foundImage !== currentImage)) {
                logger.info(`Updating system skill (${getThreadName()}) ${skillName}`);
                currentSkill.metadata = {
                    name: skillName,
                    namespace: getNamespace(),
                    labels: {
                        'fabric.project': SHARED_PROJECT,
                        'fabric.skill-version': currentVersion,
                    },
                };
                _.set(currentSkill, 'spec.actions[0].podSpec.containers[0].image', currentImage);
                if (process.env.NODE_ENV !== 'test') {
                    await k8sClient.upsertResource(K8SRESOURCES.SKILL, currentSkill);
                }
            }
        } catch (err) {
            logger.warn(`Updating system skill ${s} failed: ${err.message}`);
        }
    }));
}

async function connectRedis({ logger }, name) {
    let redis: Redis;
    let subRedis: Redis;
    const redisType = config.get('redis.type');
    // function retryStrategy(times) {
    //     const delay = config.get('redis.retry.delay');
    //     const maxTimes = config.get('redis.retry.maxTimes');
    //     if (times > maxTimes) {
    //         logger.error("Can't connect to Redis giving up");
    //         process.exit(9);
    //     }
    //     return delay;
    // }
    const opts: any = {
        maxRetriesPerRequest: config.get('redis.retry.maxTimes'),
        keepAlive: 200000,
        enableAutoPipelining: true,
//        retryStrategy,
    };
    
    const redisPass = config.get('redis.password');
    if (redisPass && redisPass !== '') {
        opts.password = redisPass;
        opts.sentinelPassword = redisPass;
    }
    logger.debug(`connecting to Redis (${name})`);
    // TODO do I need to disable subscribe connect in some cases?
    if (redisType === 'sentinel') {
        opts.sentinels = parseIfJSON(config.get('redis.options.sentinels'));
        opts.name = config.get('redis.options.name');
        redis = new Redis(parseIfJSON(opts));
        // Create redis connection for subscriptions ( connection can only do subscriptions https://github.com/luin/ioredis#pubsub-1 )
        subRedis = new Redis(parseIfJSON(opts));
    } else {
        // default to node
        redis = new Redis(config.get('redis.uri'), opts);
        subRedis = new Redis(config.get('redis.uri'), opts);
    }
    redis.select(config.get('redis.database'));
    if (isMainThread) {
        redis.on('ready', () => {
            const msg = `Connected to Redis on db# ${config.get('redis.database')}`;
            updateHealth('redis', true, msg);
            logger.info(msg);
        });
        subRedis.on('ready', () => {
            const msg = `Connected to Redis (subscribe) on db# ${config.get('redis.database')}`;
            updateHealth('redis-sub', true, msg);
            logger.info(msg);
        });
        redis.on('error', (err) => {
            const msg = `Error connecting to Redis: ${err}`;
            updateHealth('redis', false, msg);
            logger.error(msg);
        });
        subRedis.on('error', (err) => {
            const msg = `Error connecting to Redis (subscribe): ${err}`;
            updateHealth('redis-sub', false, msg);
            logger.error(msg);
        });
    }
    return { redis, subRedis };
}

async function connectMongo({ logger, redis }) {
    // Try and connect to mongo
    const connectedMsg = `Connected to MongoDB database (${getThreadName()})`;
    if (isMainThread) {  // Only need callbacks on main thread
        mongoose.connection.on('connected', () => {
            logger.info(connectedMsg);
            updateHealth('mongodb', true, connectedMsg);
        });
        mongoose.connection.on('disconnected', () => {
            updateHealth('mongodb', false, 'Connection to MongoDB database lost');
        });
    }
    try {
        mongoose.set('strictQuery', true);
        await mongoose.connect(config.get('mongo.uri'), _.assign(config.get('mongo.options'), parse(config.get('mongo.options'))));

        const migrater = new Migrater('gateway',
            mongoose.connection,
            logger,
            config.port,
            { path: new URL('../migrations', import.meta.url).pathname });
        logger.info('Running migration');
        await migrater.run(redis, config.get('migrations.pollTimeSecs'));
    } catch (e: any) {
        const msg = `Error connecting to MongoDB database, shutting down (${getThreadName()}): ${e.message}`;
        logger.error(msg);
        process.exit(1);
    }
}

export async function init({ logger }: any = {}) {
    const { redis, subRedis } = await connectRedis({ logger }, getThreadName());
    await  connectMongo({ logger, redis });

    let k8sClient;
    try {
        k8sClient = await K8SClient.newClient();
        if (k8sClient === undefined) {
            logger.error(`Error Kubernetes server is unavailable (${getThreadName()})`);
        }
        await createSystemSkill({ logger, k8sClient });
    } catch (err) {
        logger.error(`Error connecting to Kubernetes (${getThreadName()}): ${err.message}`);
    }
    // Shared logger is to allow changes to log level dynamically, other classes may create a logger when passing Infra/logger isn't convenient
    const infra = new Infra({ redis, subRedis, mongoose, k8sClient, logger });
    infra.resourceProvider = await getResourceProvider();
    infra.eventHandler = createEventHandler(infra); // Use this in synapse to send console events
    if (isMainThread) { // Only need to setup IOC on main thread.
        container.bind <Infra>(Infra).toConstantValue(infra);
        container.bind <StateStore>(StateStore).toConstantValue(getStateStore(infra));
        infra.workerPool = startWorkerPool();
    }
    return infra;

}
