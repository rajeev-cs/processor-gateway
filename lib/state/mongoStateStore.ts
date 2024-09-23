import _ from 'lodash';
import { transformDynamicParams } from '@tt-sensa/sensa-express-common';
import { SynapseState } from '../models/synapseState.model.js';
import { StateStore } from './abstractStateStore.js';
import { nativeOmit, parseJson } from '../utils.js';

/**
 * To make query simpler uppercase strings for example STATUS
 * @param val
 */
function upperIfString(val) {
    if (typeof val?.valueOf() == 'string') {
        return val.toUpperCase();
    }
    return val;
}

export class MongoStateStore extends StateStore {

    /*
        Activations
     */
    async get(id) {
        const foundRequest = await SynapseState.findOne({ requestId: id }).lean();
        if (!foundRequest) {
            return null;
        }
        const { state, transits, plan } = foundRequest;
        return { ...state, transits, plan };
    }

    async startActivation(id, m) {
        await super.startActivation(id, m);
        const state = new SynapseState({
            requestId: id,
            correlationId: m.correlationId,
            state: nativeOmit(m, 'plan'),
            plan: m.plan,
        });
        await state.save();
    }

    async endActivation(id, response, end, status) {
        await super.endActivation(id, response, end, status);
        const transits = await this.getAllTransits(id);
        await Promise.all([this._cleanup(id), SynapseState.findOneAndUpdate({ requestId: id }, {
                $set: {
                    'state.status': status,
                    'state.end': end,
                    'state.response': response,
                    transits,
                },
            }),
        ]);
    }

    /**
     * Constructs a query filter object to be used for mongo, no fields will be added to the filter unless EXPLICITLY added
     * via this function.
     * @param projectId The name of the project
     * @param agentName The name of the agent to search for activations
     * @param q generic query args to include in the filter
     * @returns {{_tenantId: *}}
     */
    static constructFilter(projectId, q) {
        const afterEqual = (t) => ({ $gte: Number(t) });
        const before = (t) => ({ $lt: Number(t) });
        const filter = {
            'state.projectId': projectId,
        };
        if (_.has(q, 'agentName')) {
            _.merge(filter, { 'state.agentName': q.agentName });
        }
        if (_.has(q, 'skillName')) {
            _.merge(filter, { 'state.skillName': q.skillName });
        }
        if (_.has(q, 'startAfter')) _.merge(filter, { 'state.start': afterEqual(q.startAfter) });
        if (_.has(q, 'startBefore')) _.merge(filter, { 'state.start': before(q?.startBefore) });
        if (_.has(q, 'endAfter')) _.merge(filter, { 'state.end': afterEqual(q?.endAfter) });
        if (_.has(q, 'endBefore')) _.merge(filter, { 'state.end': before(q?.endBefore) });
        if (_.has(q, 'status')) _.merge(filter, { 'state.status': upperIfString(q?.status ?? '') });
        if (_.has(q, 'correlationId')) _.merge(filter, { correlationId: q?.correlationId });
        if (_.has(q, 'filter')) _.merge(filter, parseJson(transformDynamicParams(q?.filter ?? {}, 'state.')));
        return filter;
    }

    async listActivations(projectId, query) {
        const limit = _.toInteger(query?.limit ?? 100);
        const skip = _.toInteger(query?.skip ?? 0);
        let mongoFilter = MongoStateStore.constructFilter(projectId, query?.filter ?? {});
        // TODO doesn't contructfilter() take care of this ?
        if (query.filter) mongoFilter = { ...mongoFilter, ...(parseJson(query.filter)) };
        const sort = query?.sort;
        let sortStart = {};
        if (sort) {
            sortStart = parseJson(transformDynamicParams(sort, 'state.'));
        }
        const l = await SynapseState.find(mongoFilter, {
            'state.requestId': 1,
            'state.agentName': 1,
            'state.skillName': 1,
            'state.status': 1,
            'state.start': 1,
            'state.end': 1,
        })
            .sort(sortStart)
            .skip(skip)
            .limit(limit)
            .lean();
        return _.map(l, (s) => ({
            activationId: s.state.requestId,
            status: s.state.status,
            start: s.state.start,
            end: s.state.end,
            agentName: s.state.agentName,
            skillName: s.state.skillName,
        }));
    }
}
