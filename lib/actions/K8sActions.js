import _ from 'lodash';
import config from 'config';
// eslint-disable-next-line import/no-unresolved
import got from 'got';
import urlJoin from 'url-join';
import * as Boom from '@hapi/boom';
import { getNamespace, K8SClient, sanitizeName } from '@tt-sensa/sensa-express-common/k8s.js';
import { toBoolean } from '@tt-sensa/sensa-express-common';
import { ActionProvider } from './abstractProvider.js';
import { createK8sTask } from './taskUtils.js';
import { GomezMustache } from '../utils.js';


const usePathTemplates = toBoolean(config?.features?.daemon_path_templates || false);
class K8sActions extends ActionProvider {
    async initialize() {
        this.k8sCient = await K8SClient.newClient();
        const { namespace, k8sOpts } = this.k8sCient;
        this.namespace = namespace; // TODO REMOVE use skill + getNamsespace() to be consistent
        this.k8sOpts = k8sOpts;
    }

    static #serviceName(skillName, actionName) {
        // FIXME clobbering exceptions if too long ?
        return sanitizeName(`${skillName}-${actionName}`);
    }

    getCombinedHeaders(properties, headers) {
        // get headers from skill properties
        const skillDefHeaders = properties ? _.fromPairs(Object.keys(properties)
            .filter((k) => k.startsWith('headers.'))
            .map((k) => [k.split('.')[1], properties[k]])) : {};
        // combine the headers with http header precedence
        return _.merge({}, skillDefHeaders, headers);
    }

    async #daemonInvoke(projectId, skill, actionName, action, params) {
        const skillName = skill.name;
        const serviceName = K8sActions.#serviceName(skillName, actionName);
        const port = params?.properties?.['daemon.port'] ?? 8080;
        // TODO get the namespace from the skill resource...
        const host = `http://${serviceName}.${getNamespace() ?? this.namespace}.svc.cluster.local:${port}`;
        // remove leading slash..
        const properties = params?.properties ?? {};
        const pathTmpl = properties?.['daemon.path'] ?? 'invoke';
        const method = (properties?.['daemon.method'] ?? 'POST').toUpperCase();
        const headers = params?.headers ?? {};
        // Use mustache templates to make dynamic routes
        const path = usePathTemplates ? GomezMustache.render(pathTmpl, params) : pathTmpl;
        // combine the http and skill property headers
        const combinedHeaders = this.getCombinedHeaders(properties, headers);
        const url = urlJoin(host, path);
        const gotOpts = { method, headers: combinedHeaders };
        if (!['GET', 'DELETE', 'TRACE', 'OPTIONS', 'HEAD'].includes(method)) { // Don't include the payload/json if the http method doesn't allow it .
            gotOpts.json = params;
        }
        const textResponse = await got(url, gotOpts).text();  // throws if the response is not non 2xx, 3xx
        // TODO support other content-types how to handle binary data ?
        // Daemons may not always return a JSON object be tolerant of this
        let response;
        try {
            response = JSON.parse(textResponse);
        } catch (e) {
            // If the response is a string wrap it in a payload
            response = { payload: textResponse };
        }
        // The response may not be JSON
        return ({ async: false, success: true, ...response });
    }

    async #jobinvoke(projectId, skill, actionName, action, params) {
        const {
 token, activationId, channelId, outputName, headers, properties, 
} = params;
        const serviceName = K8sActions.#serviceName(skill.name, actionName);
        const taskCR = createK8sTask({
            actionName,
            activationId,
            projectId, // Use the agents project for the task's name
            skill,
            channelId,
            params,
            token,
            outputName,
            action,
            serviceName,
            // taskPoolName, // perhaps configurable in future
        });
        // combine the http, kubeHttpOpts and skill property headers
        const combinedHeaders = _.merge({}, this.getCombinedHeaders(properties, headers), (this.k8sOpts.headers || {}));
        const taskCreateReq = await got(
        // TODO get namespace from skill...
        `${this.k8sCient.kc.getCurrentCluster().server}/apis/fabric.cognitivescale.com/v1/namespaces/${getNamespace() ?? this.k8sCient.namespace}/tasks`, {
            ...this.k8sOpts,
            method: 'POST',
            json: taskCR,
            headers: combinedHeaders,
        }).json();
        return ({ async: true, success: true, response: taskCreateReq });
    }

    async invoke(projectId, skillName, actionName, params) {
        const skill = await this.resourceProvider.getSkill(projectId, skillName);
        // Skill name already include projectId ?
        const serviceName = K8sActions.#serviceName(skillName, actionName);
        if (_.isEmpty(skill)) {
            throw Boom.notFound(`Unable to invoke skill "${serviceName}": skill ${skillName} not found`);
        }
        const action = skill?.actions?.find((a) => sanitizeName(a.name) === sanitizeName(actionName));
        if (_.isEmpty(action)) {
            throw Boom.notFound(`Unable to invoke skill "${serviceName}": action ${actionName} not found`);
        }
        const type = (action?.type ?? '').toLowerCase();
        if (type === 'daemon') {
            return this.#daemonInvoke(projectId, skill, actionName, action, params);
        }
        if (type === 'job') {
            return this.#jobinvoke(projectId, skill, actionName, action, params);
        }
        throw Boom.notFound(`Unable to invoke skill "${serviceName}": skillType "${type}" not supported`);
    }
}
export { K8sActions };
export default {
    K8sActions,
};
