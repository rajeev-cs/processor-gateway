import _ from 'lodash';
import { StateStore } from './abstractStateStore.js';

export class InMemoryStateStore extends StateStore {

    public states: any;

    constructor(opts) {
        super(opts);
        this.states = {};
    }

    /*
        Activations
     */
    /**
     * Take state map create or merge into existing state
     * Only support top-level keys
     * @param id = string
     * @param m - state map
     */
    async _save(id, m) {
        // no threading/async so this is safe.
        const oldState = await this.get(id);
        const newState = _.assign(oldState, m);
        newState.transits = await this.getAllTransits(id);
        this.states[id] = newState;
    }

    async startActivation(id, m) {
        await super.startActivation(id, m);
        await this._save(id, m);
    }

    async endActivation(id, response, end, status) {
        await super.endActivation(id, response, end, status);
        const transits = await this.getAllTransits(id);
        await this._save(id, {
            response,
            end,
            status,
            transits,
        });
        await this._cleanup(id);
    }

    /**
     * Get activation record
     * @param id
     * @return {Promise<any>}
     */
    async get(id) {
        return this.states?.[id] ?? {};
    }

    async listActivations(projectId, query) {
        const filter = _.get(query, 'filter');
        let activationList = Object.values(this.states);
        activationList = activationList.filter((s: any) => s.projectId === projectId);
        if (_.has(filter, 'agentName')) activationList = activationList.filter((s: any) => s.agentName === _.get(filter, 'agentName'));
        if (_.has(filter, 'skillName')) activationList = activationList.filter((s: any) => s.skillName === _.get(filter, 'skillName'));
        if (_.has(filter, 'status')) activationList = activationList.filter((s: any) => s.status === _.get(filter, 'status', '').toString().toUpperCase());
        if (_.has(filter, 'startAfter')) activationList = activationList.filter((s: any) => s.start >= _.get(filter, 'startAfter'));
        if (_.has(filter, 'startBefore')) activationList = activationList.filter((s: any) => s.start < _.get(filter, 'startBefore'));
        if (_.has(filter, 'endAfter')) activationList = activationList.filter((s: any) => s.end >= _.get(filter, 'endAfter'));
        if (_.has(filter, 'endBefore')) activationList = activationList.filter((s: any) => s.end < _.get(filter, 'endBefore'));
        return activationList.map((s: any) => ({
            activationId: s.requestId,
            status: s.status,
            start: s.start,
            end: s.end,
            agentName: s.agentName,
            skillName: s.skillName,
        }));
    }
}
