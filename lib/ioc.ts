import { Container } from 'inversify';
import 'reflect-metadata';
import { AgentController } from './controllers/agent.controller.js';
import { SessionController } from './controllers/sessions.controller.js';
import { TaskCtrl } from './controllers/tasks.js';
import { Synapse } from './synapse.js';
import { TaskController } from './controllers/task.controller.js';
import { RuntimeProvider } from './actions/runtimeProvider.js';
import { InternalController } from './controllers/internal.controller.js';
import { SystemActions } from './actions/systemActions.js';

const container = new Container({ skipBaseClassChecks: true });

// Create shared instances
// Infra & StateStore are created in ./server.js, had to move there because of access to app and to ensure infra was populated before use
container.bind<RuntimeProvider>(RuntimeProvider).to(RuntimeProvider).inSingletonScope();
// container.bind<StateStore>(StateStore).to(StateStore).inSingletonScope();  // Moved to ./server.js
container.bind<Synapse>(Synapse).to(Synapse).inSingletonScope();
// TODO     const eventHandler = getEventHandlerCtrl(app);
// TODO connectors ?
// Create controller singletons
container.bind<TaskController>(TaskController).to(TaskController).inSingletonScope();
container.bind<AgentController>(AgentController).to(AgentController).inSingletonScope();
container.bind<TaskCtrl>(TaskCtrl).to(TaskCtrl).inSingletonScope();
container.bind<SessionController>(SessionController).to(SessionController).inSingletonScope();
container.bind<InternalController>(InternalController).to(InternalController).inSingletonScope();
container.bind<SystemActions>(SystemActions).to(SystemActions).inSingletonScope();
// This is the signature needed by tsao
const iocContainer = {
    async get<T>(controller: { prototype: T }): Promise<T> {
        return container.get(controller);
    },
};
export { iocContainer, container };
