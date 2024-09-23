const defer = require('config/defer').deferConfig;

module.exports = {
    maxListeners: 1000,
    name: 'gateway',
    port: 4444,
    requestLimit: '512kb',
    mongo: {
        uri: 'mongodb://127.0.0.1:27017/cortex_services',
        options: {
            useNewUrlParser: true,
            useUnifiedTopology: true,
            maxPoolSize: 50,
        },
    },
    redis: {
        type: 'node', // one of 'node' or 'sentinel'
        uri: 'redis://127.0.0.1:6379',
        database: 0,
        password: '',
        retry: {
            maxTimes: 20,
        },
    },
    services: {
        accounts: {
            endpoint: 'http://localhost:5000',
            cacheTTL: 600,
        },
        api: {
            endpoint: 'http://localhost:8000',
        },
        // This is for processor gateway to refer to itself.
        callback: {
            endpoint: 'http://localhost:4444',
        },
        connections: {
            endpoint: 'http://localhost:4450',
        },
    },
    runtime: {
        actions: {
            invocationTimeout: 90000,
            versionActions: false,
        },
    },
    logging: {
        consoleOnly: true,
        directory: './logs',
        disableAudit: true,
        level: 'info',
        maxFiles: 14,
        maxsize: 104857600,
        prefix: defer(() => `gateway-${process.env.HOSTNAME || 'local'}`),
        tailable: true,
        zippedArchive: true,
    },
    agentLogger: {
        consoleOnly: true,
        disableAudit: true,
        enabled: true,
        logPayload: false,
        logProperties: false,
        level: 'info',
    },
    kubernetes: {
        namespace: 'cortex',
        watch_reconnect_interval: 10000,
        // 0 disables idle timeout, if no event in 5 minutes restart informer..
        // watch_idle_timeout: 300000,
        watches: [
            {
                group: 'fabric.cognitivescale.com',
                single: 'agent',
                plural: 'agents',
                version: 'v1',
            },
            {
                group: 'fabric.cognitivescale.com',
                single: 'skill',
                plural: 'skills',
                version: 'v1',
            },
        ],
        invokeImage: '',
    },
    connectors: {
        configPath: './config.d',
    },
    resources: {
        // Use local resources instead of k8s
        agentsPath: './test/data/agents',
        skillsPath: './test/data/skills',
        tasksPath: './test/data/tasks',
        // project name for shared resources
        shareProject: 'shared',
        // providers are local|k8s
        provider: 'local',
    },
    state: {
        // In memory storage, memory | mongo
        store: 'memory',
    },
    agentEvents: {
        // Log based event handler,  log | ws
        handlers: ['log', 'ws'],
        pingInterval: 30000,
    },
    features: {
        project_check_enable: false,
        projects_graphql: false, // Directly access projects collection
        scripted_skills: true, // Allow JS skills
        metrics_enabled: false,
        agent_workers: false,
        persist_tasks: true, // Store tasks in MONGO
        daemon_path_templates: true, // Allow templating of daemon routes
        disable_cache: true, // Disable caching of skills/agents from K8S
        // Use legacy behavior of always marking activation COMPLETE,
        // instead of only marking COMPLETE if ALL transits are COMPLETE
        legacy_agent_complete: false
    },
    agentWorker: {
        threads: 4,
        concurrency: 4,
        idleTimeoutMS: 30000,
        maxQueueSize: Infinity,
        stackSize: 6
    },
    // The number of asyn requests allow to execute concurrently
    synapse_concurrency: 20,
    kafka: {
        // maxQueueSize: 10, // Have MAX of 10 requests pending
        // maxParallelHandles: 4, // Only allow 4 to execute at a time
    },
    migrations: {
        pollTimeSecs: 10,
    },
};
