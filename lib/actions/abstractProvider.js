/* eslint-disable @typescript-eslint/no-unused-vars */

/* abstract */ class ActionProvider {
    constructor(resourceProvider) {
        this.resourceProvider = resourceProvider;
        if (this.constructor === ActionProvider) {
            throw new TypeError('Cannot construct abstract class ActionProvider');
        }
        if (this.initialize === ActionProvider.prototype.initialize) {
            throw new TypeError('Abstract method initialize not implemented.');
        }
        if (this.invoke === ActionProvider.prototype.invoke) {
            throw new TypeError('Abstract method invoke not implemented.');
        }
    }

    /**
     * Initialize the provider.  Returns a promise that resolves when initialization is complete.
     * The promise contains the initialized provider instance.
     */
    initialize() {
        throw new TypeError('Abstract method initialize not implemented.');
    }

    /**
     * Invoke an action and return the result as a promise.
     * @param projectId
     * @param skillname the name of the skill that is being invoked
     * @param actionname the name of the action to invoke ( within the skill )
     * @param params the params sent to the action call
     */
    invoke(projectId, skillname, actionname, params) {
        throw new TypeError('Abstract method invoke not implemented.');
    }
}
export { ActionProvider };
export default {
    ActionProvider,
};
