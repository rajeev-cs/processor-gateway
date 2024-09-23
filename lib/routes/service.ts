import { container  } from '../ioc.js';
import agentCtlFn from '../controllers/agents.js';
import { Infra } from '../interfaces/Infra.js';
import { Synapse } from '../synapse.js';
import { TaskCtrl } from '../controllers/tasks.js';

export default async (app) => {
    try {
        const infra = container.get<Infra>(Infra);
        const synapse = container.get<Synapse>(Synapse);
        const taskCtrl = container.get<TaskCtrl>(TaskCtrl);
        const agentCtrl = agentCtlFn(infra, synapse, taskCtrl);
        // This needs to remain here as tsoa doesn't seem to
        app.websocketServer.on('connection', agentCtrl.subscribeToAgentEvents);
    } catch (err: any) {
        throw Error(`error setting up websocket route: ${err.message}`);
    }
};
