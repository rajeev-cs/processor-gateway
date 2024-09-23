import _ from 'lodash';
import config from 'config';
// @ts-ignore
import { WebSocketServer } from 'ws';
import path from 'path';
import {
 toBoolean, getLogger, CortexServer,
} from '@tt-sensa/sensa-express-common';
import { fileURLToPath } from 'url';
import { healthCheck } from './controllers/healthController.js';
import pack from '../package.json' assert { type: 'json' };
import { RegisterRoutes } from './routes_gen/routes.js';
const logger = getLogger(config.get('name'), config.get('logging'));

// Allow a configurable number of listeners
// This is for websockets and k8s resources.
process.setMaxListeners(_.toInteger(config.maxListeners));
const noaauthPaths = [/^\/internal/, /^\/metrics/, /^\/stats.*/];
const server = new CortexServer({
    ...config,
    baseDir: path.dirname(new URL(import.meta.url).pathname),
    enableAuthz: false,
//    enableRoutes: false,
    enableMetrics: toBoolean(config.get('features.metrics_enabled', false)),
    authIgnorePaths: noaauthPaths,
    healthCheck,
    serverVersion: `cortex-gateway/${pack.version}`,
});

// Start websocket endpoint for agent composer WSS
const wss = new WebSocketServer({ noServer: true });
_.set(server, 'app.websocketServer', wss);
// Start express service
RegisterRoutes(server.app);

logger.info('Registering TSOA generated routes');
// Add handler for websocket requests accept request on http upgrade to wss
//}

// If running as "main" script
if (fileURLToPath(import.meta.url) === process.argv[1]) {
    try {
        await server.start();
        server.server.on('upgrade', (request, socket, head) => {
            wss.handleUpgrade(request, socket, head, (websocket) => {
                wss.emit('connection', websocket, request);
            });
        });

        // Start k8s watches
        // await k8sWatches();
    } catch (e: any) {
        logger.error(`Unable to start server: ${e.message}`);
        process.exit(1);
    }
}

export default server;
