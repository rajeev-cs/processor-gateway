import _ from 'lodash';
import * as Boom from '@hapi/boom';
import { Logger } from '@tt-sensa/sensa-express-common';
import { QualifiedName } from '@tt-sensa/sensa-admin-db';
import { InputMessage } from './actions/messages.js';
import { SynapseMessage } from './models/synapseMessage.js';
import { Synapse } from './synapse.js';
import { ResourceProvider } from './clients/resourceProvider.js';
import { RuntimeProvider } from './actions/runtimeProvider.js';

const legacySecurePropertyValueRegex = /\$\{secure\.([^}]*)/;
const securePropertyValueRegex = /#SECURE\.(.*)/;
class Activation {
    // TODO shouldn't duplicate the synapse soo much ...
    public  projectId: string;
    
    public sessionId: string;
    
    public channelId: string;
    
    public refId: string;
    
    public skill: any;
    
    public skillName: string;
    
    public agentName: string;
    
    public input: string; // skill input
    
    public inputName: string; // human name ??
    
    public activationId: string;
    
    public logMeta: any;
    
    constructor({ msg, ref, skill, input, agentName }) {
        this.projectId = msg.projectId;
        this.sessionId = msg.sessionId;
        this.channelId = msg.channelId;
        this.refId = ref.refId;
        this.skill = skill;
        this.skillName = ref.skillName; // ref's name incase k8s clobbers the name
        this.agentName = agentName;
        this.input = input;
        this.inputName = input.name;
        this.activationId = msg.requestId || msg.activationId; // we support both siiigh
        this.logMeta = {
            activationId: this.activationId,
            skillRefId: this.refId,
            inputName: this.inputName,
            skillName: this.skillName,
            agentName: this.agentName,
            sessionId: this.sessionId,
            projectId: this.projectId,
        };
    }
}
class Skill {
    
    public eventHandler: any;

    public agentName: any;  // need Qname type.

    public skillName: string;
    
    public reference: any;
    
    public definition: any;
    
    public input: string;
    
    public synapse: Synapse;
    
    public secrets: any;
    
    public logger: Logger;
    
    public resourceProvider: ResourceProvider;
    
    public runtimeProvider: RuntimeProvider;
    
    constructor(agentName, step, skillDef, synapse, secrets) {
        this.eventHandler = synapse.eventHandler;
        this.skillName = step?.ref?.skillName ?? skillDef.name;
        this.reference = step.ref;
        this.definition = skillDef;
        // If user hasn't specified input name use inputName defined on the skillRef ( if it exists )
        this.input = step?.toInput ?? step?.ref?.inputName;
        this.synapse = synapse;
        this.secrets = secrets;
        this.logger = synapse.logger;
        this.resourceProvider = synapse.resourceProvider;
        this.runtimeProvider = synapse.runtimeProvider;
        if (agentName) {
            // Might not have this ofr skill invokes..
            this.agentName = QualifiedName.fromString(agentName, false);
        }
    }

    /*
      build properties in this order:
       1. use properties passed in on activation
       2. Use the default value set at the skill definition level
       3. Use agent properties as agent level defaults
       4. Use skill reference specific property values
       Finally. lookup secrets if they exist..
     */
    async getProperties(projectId) {
        if (_.isEmpty(this.definition.properties)) return {};
        const propertyNames = _.map(this.definition.properties, (prop) => prop.name);
        const properties = _.map(propertyNames, (n) => [n, this.resolvePropertyValue(n)]);
        // TODO support inline secrets  "mongoddb://${secure.username}:${secure.password}/dsdsdsd"
        const legacySecureProperties = _.filter(properties, (p) => _.startsWith(_.tail(p), '${secure.'));
        const legacySecurePropertyNames = _.map(legacySecureProperties, (p) => _.first(p));
        // get the secure key name from ${secure.NAME}
        const legacySecureKeys = _.map(legacySecureProperties, (p) => _.nth(_.last(p).match(legacySecurePropertyValueRegex), 1));
        const secureProperties = _.filter(properties, (p) => _.startsWith(_.tail(p), '#SECURE.'));
        const securePropertyNames = _.map(secureProperties, (p) => _.first(p));
        // get the secure key name from #SECURE.NAME
        const secureKeys = _.map(secureProperties, (p) => _.nth(_.last(p).match(securePropertyValueRegex), 1));
        try {
            const legacySecureValues = await this.secrets.getSecrets(projectId, legacySecureKeys, 'variables');
            const secureValues = await this.secrets.getSecrets(projectId, secureKeys);
            return _.merge(_.fromPairs(properties), _.zipObject(legacySecurePropertyNames, legacySecureValues), _.zipObject(securePropertyNames, secureValues));
        } catch (err) {
            this.logger.warn(`Problem fetching secure properties: ${err?.response?.body ?? err.message}`);
            throw err;
        }
    }

    resolvePropertyValue(propertyName) {
        let propertyValue;
        // 1. Use the default value set at the skill definition level
        const skillDefProp = this.definition.properties.find((prop) => prop.name === propertyName);
        propertyValue = skillDefProp?.value ?? skillDefProp?.defaultValue;
        // 2. Use agent properties as agent level defaults
        // plan will contain agentdef and skillref properties merged
        // 3. Use agent skill reference specific property values
        if (!_.isEmpty(this?.reference?.properties)) {
            const skillRefProp = this.reference.properties.find((prop) => prop.name === propertyName);
            propertyValue = skillRefProp?.value ?? propertyValue;
        }
        return propertyValue;
    }

    async run(msg: SynapseMessage) {
        const def = this.definition;
        const ref = this.reference;
        const refName = ref.title || ref.skillName;
        const input = this.definition.inputs.find((i) => this.input === i.name);
        const agentName = this.agentName ? this.agentName.getNamespaceAndName() : '';
        const { skillName } = ref;
        if (_.isEmpty(input)) {
            throw new Error(`Unable to invoke skill "${refName}" (${skillName}): No skill input named "${this.input}"`);
        }
        this.logger.debug(`SKill run on input ${refName} => ${input?.name ?? 'NO NAME'}`, msg.getLogMeta());
        const inputEvent = {
            agentName,
            skillName,
            refId: ref.refId,
            input: input.name,
            message: msg.toEventObject(),
        };
        await this.eventHandler.publishEvent(msg.requestId, 'skill.input', inputEvent);
        const activation = new Activation({
            msg,
            ref,
            skill: def,
            input,
            agentName,
        });
        const outputEvent: any = {
            agentName,
            skillName,
            refId: ref.refId,
        };
        let result: any = {};
        try {
            result = await this.routeInput(activation, msg);
            // For synchronous actions, we can route the output
            if (result?.outputName && (result?.async ?? false) === false) {
                this.logger.debug(`Routing skill output to ${result.outputName}`, activation.logMeta);
                const outputMsg = SynapseMessage.replacePayload(msg, result?.payload, this.reference?.refId);
                // Output event emitted in finally
                outputEvent.success = true;
                outputEvent.outputName = result.outputName;
                outputEvent.message = outputMsg.toEventObject();
                outputMsg.outputName = result.outputName;
                if (result.error) outputEvent.error = result.error;
                return { async: false, outputMsg };
            }
            return { async: true }; // return async for jobs ( yeah it is a synapseMessage sorta)
        } catch (e) {
            let errMsg = `Error invoking skill "${refName}" (${skillName}): ${e.message} `;
            // If got HTTPError add response body to message
            if (e?.response) {
                // If I have bad GW check skill status
                if (e?.response.statusCode === 503) {
                    const k8sSkill = await this.resourceProvider.getSkill(msg.projectId, skillName);
                    errMsg += `Daemon: ${(k8sSkill?.status?.actionStatus ?? []).map((s) => `${s.name}:${s.state} available`).join(' ')}`;
                } else {
                    errMsg += e.response.body;
                }
            }
            outputEvent.async = false;
            outputEvent.success = false;
            outputEvent.message = msg.toEventObject();
            outputEvent.message.timestamp = Date.now();
            outputEvent.message.payload = { error: msg };
            // Below is the preferred method of propagating error, consistent with jobs.
            // Above retained for compatibility
            outputEvent.message.error = errMsg;
            throw new Error(errMsg);
        } finally {
            // IF Jobs ( or other async ) cortex-actions will be responsible for publishing events
            if ((result?.async ?? false) === false) {
                await this.eventHandler.publishEvent(msg.requestId, 'skill.output', outputEvent);
            }
        }
    }

    async routeInput(activation, msg) {
        const {
             agentName, input, skillName, logMeta,
        } = activation;
        const { projectId, payload } = msg;
        const { routing } = input;
        let properties = {};
        try {
            properties = await this.getProperties(msg.projectId);
        } catch (e) {
            throw new Error(`Unable to resolve all skill property values: ${e.message}`);
        }
        function processRoute(routeType, routeObj) {
            return {
                action: routeObj?.action,
                runtime: routeObj?.runtime ?? 'cortex/functions',
                output: routeObj.output,
                routeType,
            };
        }
        function validateRoute(r) {
            const issues = [];
            if (!r) {
                issues.push('can\'t find all|default|rules[] route to process');
                return issues;
            }
            if (!r.action && r.runtime !== 'cortex/external-api') issues.push(`routes.${r.routeType} is missing an action`);
            if (!r.output) issues.push(`routes.${r.routeType} has no output defined`);
            return issues;
        }
        function findRouteMatch(routing2, key, context) {
            // lowercase for case-insensitive match
            const val = _.toLower(context?.[key]); // always return a string '' for undefined
            if (_.isEmpty(val)) return undefined;
            return routing2.rules.find((r) => _.toLower(r.match) === val);
        }
        let route;
        // ALL route if processed over any other routing.
        // USE!! _.isEmpty(), golang is adding empty objects for empty attributes, check if really empty versus _.has()
        if (!_.isEmpty(routing?.all)) {
            route = processRoute('all', routing.all);
        } else {
            let routeType;
            let key;
            let context;
            // PROPERTY route
            if (!_.isEmpty(routing?.property)) {
                key = routing.property;
                context = properties;
                routeType = 'property';
                // FIELD route
            } else if (!_.isEmpty(routing?.field)) {
                key = routing.field;
                context = payload;
                routeType = 'field';
            }
            const rule = findRouteMatch(routing, key, context);
            if (rule) {
                route = processRoute(routeType, rule);
            } else {
                // DEFAULT route
                const routeName = `${agentName}.${this.definition.name}.routing.${routeType}`;
                this.logger.debug(`${routeName} no rule matches using default`, logMeta);
                if (!_.isEmpty(routing?.default)) {
                    route = processRoute('default', routing.default);
                } else {
                    const routeIssue = `No matching route found for ${routeType} routing and no default`;
                    throw new Error(`Error processing ${this.definition.name} routes: ${routeIssue}`);
                }
            }
        }
        const issues = validateRoute(route);
        if (_.isEmpty(issues)) {
            const inputMsg = new InputMessage({
                ...msg,
                ...activation,
                projectId,
                properties,
                skillTitle: this?.reference?.title || this?.definition?.title, 
                channelId: this?.reference?.refId,
                outputName: route.output,
            });
            const actionQName = route.action;
            const result = await this.invokeAction(projectId, actionQName, route.runtime, inputMsg);
            if ((result?.async ?? false) === false && !result?.payload) {
                throw new Error(`Error invoking skill ${skillName}.${actionQName} response must include 'payload'`);
            }
            if (_.isEmpty(result?.outputName)) {
                // Is undefined/null/"" use outputName from routes.
                result.outputName = route.output;
            }
            // I had a custom outputName
            return result;
        }
        throw new Error(`Error processing ${this.definition.name} routes: ${_.join(issues)}`);
    }

    async invokeAction(projectId, functionName, runtimeName, inputMsg) {
        try {
            const runtime = await this.runtimeProvider.getRuntime(runtimeName, this.resourceProvider);
            return runtime.invoke(projectId, this.skillName, functionName, inputMsg.toParams());
        } catch (err) {
            throw Boom.internal(`Error invoking action: ${this.skillName}-${functionName}: ${err?.error?.message ?? err.message}`);
        }
    }
}
export { Skill };
export default {
    Skill,
};
