import chai from 'chai';
import chaiAsPromised from 'chai-as-promised';
import nock from 'nock';
import { SecretsClient } from '../lib/clients/cortexClient.js';

const { expect } = chai;
chai.use(chaiAsPromised);
const CORTEX_API = 'http://localhost:8888';
const projectId = 'varProjTest';
/* eslint-disable no-unused-expressions */ // needed for expect .to.be.rejected
describe('test secrets', () => {
    let secrets;
    before((done) => {
        secrets = new SecretsClient('token');
        done();
    });
    it('should resolve a single, existing secure value', async () => {
        nock(CORTEX_API)
            .get(`/internal/projects/${projectId}/secrets/?keys=key1`)
            .reply(200, { key1: { value: 'key1Value' } });
        const res = await secrets.getSecrets(projectId, ['key1']);
        expect(res).to.deep.equal(['key1Value']);
    });
    it('should resolve multiple, existing secure values', async () => {
        nock(CORTEX_API)
            .get(`/internal/projects/${projectId}/secrets/?keys=key1,key2`)
            .reply(200, { key1: { value: 'key1Value' }, key2: { value: 'key2Value' } });
        const vars = await secrets.getSecrets(projectId, ['key1', 'key2']);
        expect(vars).to.deep.equal(['key1Value', 'key2Value']);
    });
    it('should resolve multiple, existing secure values under a specified root key', async () => {
        nock(CORTEX_API)
            .get(`/internal/projects/${projectId}/secrets/variables/?keys=key1,key2`)
            .reply(200, { key1: { value: 'key1Value' }, key2: { value: 'key2Value' } });
        const vars = await secrets.getSecrets(projectId, ['key1', 'key2'], 'variables');
        expect(vars).to.deep.equal(['key1Value', 'key2Value']);
    });
    it('should resolve the subset of secure values that actually accessible', async () => {
        nock(CORTEX_API)
            .get(`/internal/projects/${projectId}/secrets/?keys=key1,badKey`)
            .reply(200, { key1: { value: 'key1Value' } });
        return expect(secrets.getSecrets(projectId, ['key1', 'badKey'])).to.be.rejected;
    });
    it('should handle the case where no secure values are accessible', async () => {
        nock(CORTEX_API)
            .get(`/internal/projects/${projectId}/secrets/?keys=badKey1,badKey2`)
            .reply(200, {});
        return expect(secrets.getSecrets(projectId, ['badKey1', 'badKey2'])).to.be.rejected;
    });
    it('should handle an empty keys array', async () => {
        nock(CORTEX_API)
            .get(`/internal/projects/${projectId}/secrets/?key=`)
            .reply(200, {});
        return expect(secrets.getSecrets(projectId, [])).to.eventually.deep.equal([]);
    });
    it('should reject when resolving an invalid secure key', async () => {
        nock(CORTEX_API)
            .get(`/internal/projects/${projectId}/secrets/?keys=doesNotExist`)
            .reply(404, {});
        return expect(secrets.getSecrets(projectId, 'doesNotExist')).to.be.rejected;
    });
    //
    it('should reject when secret missing', async () => {
        nock(CORTEX_API)
            .get(`/internal/projects/${projectId}/secrets/?keys=doesNotExist`)
            .reply(200, []);
        return expect(secrets.getSecrets(projectId, ['doesNotExist'])).to.be.rejected;
    });
    it('should reject when a secret is missing from list', async () => {
        nock(CORTEX_API)
            .get(`/internal/projects/${projectId}/secrets/?keys=one,two,doesNotExist`)
            .reply(200, { one: { value: 'oneSec' }, two: { value: 'twoSec' } });
        return expect(secrets.getSecrets(projectId, ['one', 'two', 'doesNotExist'])).to.be.rejected;
    });
});
