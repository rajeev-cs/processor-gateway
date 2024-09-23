import mongoose from 'mongoose';
/**
 * Jwt Store store jwts from cortex-auth
 */
const SynapseStateSchema = new mongoose.Schema({
    requestId: {
        type: String,
        required: true,
    },
    // An optional Id to link multiple activations together..
    correlationId: {
        type: String,
        required: false,
    },
    state: {
        type: Object,
        required: false,
    },
    plan: {
        type: Object,
        required: false,
    },
    transits: [new mongoose.Schema({
            from: {
                type: String,
                required: true,
            },
            to: {
                type: String,
                required: true,
            },
            start: {
                type: Date,
                required: false,
            },
            end: {
                type: Date,
                required: false,
            },
            name: {
                type: String,
                required: false,
            },
            status: {
                type: String,
            },
        })],
});
// Indexes
SynapseStateSchema.index({ requestId: 1 }, { unique: false });
SynapseStateSchema.index({ correlationId: 1 }, { unique: false });
const SynapseState = mongoose.model('SynapseState', SynapseStateSchema, 'SynapseState');
export { SynapseState };
export default {
    SynapseState,
};
