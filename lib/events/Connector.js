class Connector {
    constructor(cConfig) {
        this.cConfig = cConfig;
        this.type = '???';
    }

    /**
     * Start the event connector
     * @return {Promise<void>}
     */
    async start(workerPool) {
        throw new Error(`Implement me ${workerPool}`);
    }

    /**
     * Handle callback from
     * @param msg
     * @return {Promise<void>}
     */
    async handleCallBack(synapseMsg, response, status) {
        throw new Error(`Implement me ${synapseMsg} ${response} ${status}`);
    }
}
export { Connector };
export default {
    Connector,
};
