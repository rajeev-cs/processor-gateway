import _ from 'lodash';
import { safeParseIfJSON } from '@tt-sensa/sensa-express-common';

function decodePropertyDef(propDef) {
    return ({
        ...propDef,
        defaultValue: safeParseIfJSON(propDef.defaultValue),
        value: safeParseIfJSON(propDef.value),
    });
}
function decodePropertyValue(prop) {
    return ({
        ...prop,
        value: safeParseIfJSON(prop.value),
    });
}

/**
 * Since storing any type was too difficult we stored property values as JSON in k8s resource.  This forces us to do some JSON decoding ..
 */
function decodeSkillRefPropertyValues(skillRef) {
    return ({
        ...skillRef,
        properties: _.map(skillRef.properties, decodePropertyValue),
    });
}
function getUpdateTime(resource) {
    const creationTime = new Date(resource?.metadata?.creationTimestamp);
    return new Date().getTime() - creationTime;
}
function decodeOutputSignalPropertyValues(signal) {
    return ({
        ...signal,
        ...(signal.catch ? { catch: decodeSkillRefPropertyValues(signal.catch) } : {}),
        ...(signal.finally ? { finally: decodeSkillRefPropertyValues(signal.finally) } : {}),
    });
}
export function decodeAgentResource(agent) {
    return ({
        updateTimeMS: getUpdateTime(agent),
        ...agent,
        spec: {
            ...agent.spec,
            outputs: _.map(agent.spec.outputs, decodeOutputSignalPropertyValues),
            properties: _.map(agent.spec.properties, decodePropertyDef),
            skills: _.map(agent.spec.skills, decodeSkillRefPropertyValues),
        },
    });
}
export function decodeSkillResource(skill) {
    return ({
        updateTimeMS: getUpdateTime(skill),
        ...skill,
        spec: {
            ...skill.spec,
            properties: _.map(skill.spec.properties, decodePropertyDef),
        },
    });
}
export function decodeResource(inst) {
    const { kind } = inst;
    if (kind === 'Agent') return decodeAgentResource(inst);
    if (kind === 'Skill') return decodeSkillResource(inst);
    return inst;
}
