import './testenv.js';
import { container } from '../lib/ioc.js';
import Infra from '../lib/interfaces/Infra.js';
import chai from 'chai';
import server from '../lib/server.js';
import request from 'supertest';
import { checkResponse } from './testutil/index.js';

describe('sanity', () => {
    let infra;
     before(async () => {
        infra = container.get<Infra>(Infra);
    });

    it('add/delete skill, check cache', async () => {
        const skill = { metadata: { name: 'my-skill' } };
        await request(server.app)
            .post('/internal/resources/skills')
            .set('Accept', 'application/json')
            .send(skill)
            .then((res) => checkResponse(res, 200, false));

        const { _body: skillCache } = await request(server.app)
            .get('/internal/resources/skills')
            .set('Accept', 'application/json')
            .expect(200);
        chai.expect(skillCache).to.include(skill.metadata.name);

        await request(server.app)
            .delete('/internal/resources/skills')
            .set('Accept', 'application/json')
            .send(skill)
            .then((res) => checkResponse(res, 200, false));

        const { _body: skillCacheDel } = await request(server.app)
            .get('/internal/resources/skills')
            .set('Accept', 'application/json')
            .expect(200);
        chai.expect(skillCacheDel).to.not.include(skill.metadata.name);
    });

    it('add/delete agent, check cache', async () => {
        const agent = { metadata: { name: 'myproj-myagent' }, spec: { description: 'Original desc' } };
        const planCacheKey =  `${agent.metadata.name}-input`;
        // Add item to cache to ensure it get clears after update..
        infra.resourceProvider.cache.plans[planCacheKey] = { foo:'bar' };
        // Agent should be preloaded in cache, so we can test removal with updates/delete
        const { _body: planCache1 } = await request(server.app)
            .get('/internal/resources/plans')
            .set('Accept', 'application/json')
            .expect(200);
            chai.expect(planCache1).to.include(planCacheKey);

        // Update agent
        const updateDescr =  'agent got updated';
        agent.spec.description = updateDescr;
        await request(server.app)
            .post('/internal/resources/agents')
            .set('Accept', 'application/json')
            .send(agent)
            .then((res) => checkResponse(res, 200, false));

        // Updated agent should be in agent cache
        const { _body: cachedAgent } = await request(server.app)
            .get('/internal/myproj/resources/agents/myagent')
            .set('Accept', 'application/json')
            .expect(200);
        chai.expect(cachedAgent).to.nested.property('spec.description').equal(updateDescr);

        // Update should have removed agent from plan cache
        const { _body: planCache2 } = await request(server.app)
            .get('/internal/resources/plans')
            .set('Accept', 'application/json')
            .expect(200);
        chai.expect(planCache2).to.not.include(planCacheKey);

        // Re-add agent to  plan cache
        infra.resourceProvider.cache.plans[planCacheKey] = { foo:'bar' };
        await request(server.app)
            .delete('/internal/resources/agents')
            .set('Accept', 'application/json')
            .send(agent)
            .then((res) => checkResponse(res, 200, false));

        // delete should also remove agent from plan cache
        const { _body: planCache3 } = await request(server.app)
            .get('/internal/resources/plans')
            .set('Accept', 'application/json')
            .expect(200);
        chai.expect(planCache3).to.not.include(planCacheKey);

        // agent should be removed fom agent cache
        const { _body: agentCacheDel } = await request(server.app)
            .get('/internal/resources/agents')
            .set('Accept', 'application/json')
            .expect(200);
        chai.expect(agentCacheDel).to.not.include(agent.metadata.name);

    });

    it('responds to GET /internal/resources/agents/not-here', async () => {
        await request(server.app)
            .get('/internal/resources/agents/foo-bar')
            .set('Accept', 'application/json')
            .expect(404)
            .then((res) => checkResponse(res, 404, false));
    });

    it('responds to GET /internal/resources/skills/not-here', async () => {
        await request(server.app)
            .get('/internal/resources/skills/foo-bar')
            .set('Accept', 'application/json')
            .then((res) => checkResponse(res, 404, false));
    });

});
