import yaml from 'js-yaml';
import config from 'config';
import fs from 'fs';
import { glob } from 'glob';

import { tok8sName } from '@tt-sensa/sensa-express-common/k8s.js';
import { ResourceProvider } from './resourceProvider.js';

/**
 * Provide cortex agents/skills/etc. via a snapshot document
 * This is probably more for testing/local execution
 */
export class FilesystemResource extends ResourceProvider {

    private projectId: string;

    constructor(opts) {
        super();
        this.projectId = opts.projectId ?? 'cogscale';
    }

    async initialize() {
        const agentFiles = glob.sync(`${config.resources.agentsPath}/*.+(json|yaml|yml)`);
        const skillFiles = glob.sync(`${config.resources.skillsPath}/*.+(json|yaml|yml)`);
        agentFiles.forEach((agentFile) => {
            const agent: any = yaml.load(fs.readFileSync(agentFile).toString());
            this.cache.agents[tok8sName(agent.projectId || this.projectId, agent.name)] = agent;
        });
        skillFiles.forEach((skillFile) => {
            const skill: any = yaml.load(fs.readFileSync(skillFile).toString());
            const k8sName = tok8sName(skill.projectId || this.projectId, skill.name);
            skill.name = k8sName;
            this.cache.skills[k8sName] = skill;
        });
    }
    // File cache doesn't support update()/delete()

}
