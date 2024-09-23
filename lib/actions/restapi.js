import _ from 'lodash';
// eslint-disable-next-line import/no-unresolved
import got from 'got';
import urlJoin from 'url-join';
import { ActionProvider } from './abstractProvider.js';
import { GomezMustache } from '../utils.js';
import { toBoolean } from '@tt-sensa/sensa-express-common';

import config from 'config';

const usePathTemplates = toBoolean(config?.features?.daemon_path_templates || false);
export class RestAction extends ActionProvider {
    initialize() {
        // nothing to do here
    }

    async invoke(projectId, skillName, actionName, params) {
        // what else to support ?
        // TODO proxy support
        const { properties, payload } = params;
        const { url, path: pathTmpl, method, headers, queryParams } = properties;
        if (_.isEmpty(url)) {
            throw new Error('\'url\' property is required');
        }
        const path = usePathTemplates ? GomezMustache.render(pathTmpl, params) : pathTmpl;
        const fullUrl = urlJoin(url, path);
        const httpHeaders = params?.headers ?? {};
        const extraHeaders = _.merge(headers, _.fromPairs(Object.keys(properties)
            .filter((k) => k.startsWith('headers.'))
            .map((k) => [k.split('.')[1], properties[k]])), httpHeaders);
        const gotOpts = {
            headers: extraHeaders,
            method: method || 'POST',
            searchParams: queryParams,
        };
        if (['POST', 'PUT', 'PATCH'].includes(gotOpts.method.toUpperCase())) {
            gotOpts.json = payload;
        }
        const response = await got(fullUrl, gotOpts).json();
        return ({ async: false, success: true, payload: response });
    }
}
