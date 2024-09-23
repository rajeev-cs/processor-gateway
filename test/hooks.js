import './testenv.js';
import { RedisMemoryServer } from 'redis-memory-server';
import mongodbMemoryServer from 'mongodb-memory-server';
import tsNode from 'ts-node';
import 'reflect-metadata';
import server from '../lib/server.js';

tsNode.register({
    files: true,
    transpileOnly: true,
    swc: true,
    esm: true,
    project: './test/tsconfig.json',
});

const { MongoMemoryServer } = mongodbMemoryServer;
export async function mochaGlobalSetup() {
    // global setup for all tests
    console.log('Starting mongo & redis');
    this.mongodb = await MongoMemoryServer.create({ instance: { port: 26017 } });
    this.redisServer = new RedisMemoryServer({ instance: { port: 8379 } });
    await this.redisServer.getIp();
    this.app = await server.start();
    this.server = server;
}

export async function mochaGlobalTeardown() {
    console.log('Stopping mongo & redis');
    await this.redisServer.stop();
    await this.mongodb.stop();
    await this.server.stop();
}
