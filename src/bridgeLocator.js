let instance = null;

module.exports = {
    setInstance(mainBridgeInstance) {
        instance = mainBridgeInstance;
    },

    getInstance() {
        return instance;
    },

    reset() {
        instance = null;
    }
};
