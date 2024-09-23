/**
 * Add any environment variable you want to set for tests.
 * This is parsed before test code is executed via hooks.js
 * @type {string}
 */
// ensure always set, helps running individual tests in an IDE
process.env.NODE_ENV = 'test';
// allow changes to config/
process.env.ALLOW_CONFIG_MUTATIONS = 'true';
