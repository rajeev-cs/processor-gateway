import { injectable } from 'inversify';
import { Redis } from 'ioredis';
import { Logger } from '@tt-sensa/sensa-express-common';
import { EventHandler } from '../events/handler.js';
import { Piscina } from 'piscina';
import { ResourceProvider } from '../clients/resourceProvider.js';

/**
 * Rather than using express instance "server.app" from ./lib/server.ts,
 * use a class to gather/share infra and singletons used throughout the app
 */
@injectable()
export class Infra {

    public redis: Redis;

    // Redis client used for subscriptions;
    public subRedis: Redis;

    public logger: Logger;

    public mongoose: any;

    public k8sClient?: any;

    public workerPool: Piscina;

    // These require Infra to function so not happy with these being here
    // However not sure adding another interface is worthwhile ATM.
    public eventHandler: EventHandler;

    public resourceProvider: ResourceProvider;

    constructor(opts: any) {
        this.redis = opts.redis;
        this.subRedis = opts.subRedis;
        this.mongoose = opts.mongoose;
        this.logger = opts.logger;
        this.k8sClient = opts.k8sClient;
        this.eventHandler = opts.eventHandler;
        this.resourceProvider = opts.resourceProvider;
    }

}

export default Infra;
