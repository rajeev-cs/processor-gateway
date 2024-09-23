/* eslint-disable @typescript-eslint/no-unused-expressions */
import './testenv.js';
import server from '../lib/server.js';
import request from 'supertest';
import { checkResponse, getToken } from './testutil/index.js';
import { expect } from 'chai';

const bearer = `bearer ${getToken()}`;

describe('sanity', () => {
    it('responds to /ops/healthcheck', async () => {
        await request(server.app)
            .get('/ops/healthcheck')
            .expect(200)
            .then((res) => checkResponse(res, 200, false));
    });


    it('responds 401 to GET /fabric/v4/projects/cogscale/tasks', async () => {
        await request(server.app)
            .get('/fabric/v4/projects/cogscale/tasks')
            .set('Accept', 'application/json')
            .then((res) => checkResponse(res, 401));
    });

    it('responds 401 to GET /fabric/v4/projects/cogscale/agents/foo/invoke/bar', async () => {
        await request(server.app)
            .get('/fabric/v4/projects/cogscale/agents/foo/invoke/bar')
            .set('Accept', 'application/json')
            .then((res) => checkResponse(res, 401));
    });

    it('responds 401 to GET /fabric/v4/projects/cogscale/activations', async () => {
        await request(server.app)
            .get('/fabric/v4/projects/cogscale/activations')
            .set('Accept', 'application/json')
            .then((res) => checkResponse(res, 401));
    });

    it('responds 404 to GET /nothere', async () => {
        await request(server.app)
            .get('/nothere')
            .set('Accept', 'application/json')
            .set('Authorization', bearer)
            .then((res) => checkResponse(res, 404));
    });

    it('responds to GET /fabric/v4/projects/cogscale/sessions', async () => {
        await request(server.app)
            .get('/fabric/v4/projects/cogscale/sessions')
            .set('Accept', 'application/json')
            .set('Authorization', bearer)
            .then((res) => checkResponse(res, 200));
    });

    it('responds to POST /fabric/v4/projects/cogscale/sessions', async () => {
        const res = await request(server.app)
            .post('/fabric/v4/projects/cogscale/sessions')
            .set('Accept', 'application/json')
            .set('Authorization', bearer)
            .send({ state: { somekey: 1234 } })
            .expect(200);
        const { sessionId } = checkResponse(res, 200);
        // eslint-disable-next-line no-unused-expressions
        expect(sessionId).is.not.empty;
        const getRes = await request(server.app)
            .get(`/fabric/v4/projects/cogscale/sessions/${sessionId}`)
            .set('Accept', 'application/json')
            .set('Authorization', bearer)
            .expect(200);
        const { state } = checkResponse(getRes, 200);
        expect(state.somekey).to.eq(1234);
    });

    it('responds 404 to DELETE session /fabric/v4/projects/cogscale/sessions/nothere', async () => {
        await request(server.app)
            .delete('/fabric/v4/projects/cogscale/sessions/nothere')
            .set('Accept', 'application/json')
            .set('Authorization', bearer)
            .then((res) => checkResponse(res, 404, false));
    });

});
