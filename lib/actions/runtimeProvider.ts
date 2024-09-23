import config from 'config';
import { inject, injectable } from 'inversify';
import { K8sActions } from './K8sActions.js';
import { RestAction } from './restapi.js';
import { ActionProvider } from './abstractProvider.js';
import { ResourceProvider } from '../clients/resourceProvider.js';
import { Infra } from '../interfaces/Infra.js';
import { SystemActions } from './systemActions.js';

const callbackUrlBase = config.services.callback.endpoint;

@injectable()
export class RuntimeProvider {
    private instances: ActionProvider[];

    // Used for tests only ?
    public cb?: (callback: string) => {} | undefined;

    private readonly infra: Infra;

    constructor(@inject(Infra) infra: Infra) {
        this.instances = [];
        this.infra = infra;
        this.cb = undefined;
    }

    async flushProviders() {
        Object.keys(this.instances).forEach((k) => delete this.instances[k]);
    }

    /**
     * Factory method to create an instance of a runtime action provider.
     * @param runtimeName
     * @param resourceProvider
     * @param synapse
     */
    async getRuntime(runtimeName: string, resourceProvider: ResourceProvider) { // }, synapse?: Synapse) {
        const inst = this.instances?.[runtimeName];
        if (inst) {
            return inst;
        }
        let newInst;
        switch (runtimeName) {
            case 'cortex/test-daemon':
                newInst = {
                    initialize: () => { },
                    invoke: async (projectId, skillname, actionname, params) => {
                        if (params?.payload?.error) {
                            return ({
                                async: false,
                                success: false,
                                error: params.payload.error,
                                payload: {},
                            });
                        }
                        if (params?.payload?.exception) {
                            throw new Error(params.payload.exception);
                        }
                        return ({
                            async: false,
                            success: true,
                            payload: {
                                projectId,
                                skillname,
                                actionname,
                                params,
                            },
                        });
                    },
                };
                break;
            case 'cortex/test-job':
                // console.warn('USING cortex/test-job PROVIDER');
                newInst = {
                    initialize: () => {
                    },
                    invoke: async (projectId, skillName, actionName, params) => {
                        const callbackUrl = `${callbackUrlBase}/internal/tasks/${params.activationId}/${params.channelId}`;
                        if (this.cb) this.cb(callbackUrl); // only used for skill/agent invoke tests ( to facilitate getting the skill/channelId )
                        return ({
                            async: true,
                            success: true,
                            payload: `test job: project: ${projectId} skill: ${skillName} action: ${actionName}`,
                            callback: callbackUrl, // This is just added for testing
                        });
                    },
                };
                break;
            case 'cortex/external-api':
                newInst = new RestAction(resourceProvider);
                break;
            case 'cortex/system':
                newInst = new SystemActions(this.infra);
                break;
            default:
                 newInst = new K8sActions(resourceProvider);
        }
        await newInst.initialize();
        this.instances[runtimeName] = newInst;
        return newInst;
    }
}
