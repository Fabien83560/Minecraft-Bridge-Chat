// Specific Imports
const BotManager = require("./client/botManager.js")
const BridgeLocator = require("../bridgeLocator.js");
const logger = require('../shared/logger');

class MinecraftManager {
    constructor() {
        const mainBridge = BridgeLocator.getInstance();
        this.config = mainBridge.config;

        this._isInitialized = false;
        this._isStarted = false;
        this._botManager = null;

        // Event handlers
        this.messageHandlers = [];
        this.eventHandlers = [];
        this.connectionHandlers = [];
        this.errorHandlers = [];

        this.initialize();
    }

    async initialize() {
        if(this._isInitialized) {
            logger.warn("MinecraftManager already initialized");
            return;
        }

        try {
            logger.minecraft("Initializing Minecraft module...");

            this._botManager = new BotManager();

            this._isInitialized = true;
            logger.minecraft("✅ Minecraft module initialized")
        } catch (error) {
            logger.logError(error, 'Failed to initialize Minecraft module');
            throw error;
        }
    }

    async start() {
        if(!this._isInitialized)  {
            throw new Error('MinecraftManager must be initialized before starting');
        }

        if (this._isStarted) {
            logger.warn('MinecraftManager already started');
            return;
        }

        try {
            logger.minecraft('Starting Minecraft connections...');
            
            // Start all bot connections
            await this._botManager.startAll();
            
            this._isStarted = true;
            logger.minecraft('✅ All Minecraft connections started successfully');
            
        } catch (error) {
            logger.logError(error, 'Failed to start Minecraft connections');
            throw error;
        }
    }

    async stop() {
        if (!this._isStarted) {
            logger.debug('MinecraftManager not started, nothing to stop');
            return;
        }

        try {
            logger.minecraft('Stopping Minecraft connections...');
            
            if (this._botManager) {
                await this._botManager.stopAll();
            }
            
            this._isStarted = false;
            logger.minecraft('✅ All Minecraft connections stopped');
        
        } catch (error) {
            logger.logError(error, 'Error stopping Minecraft connections');
            throw error;
        }
    }

    setupEventForwarding() {
        // Forward bot manager events to external handlers
        this._botManager.onMessage((data) => {
            this.messageHandlers.forEach(handler => {
                try {
                    handler(data);
                } catch (error) {
                    logger.logError(error, 'Error in message handler');
                }
            });
        });

        this._botManager.onEvent((data) => {
            this.eventHandlers.forEach(handler => {
                try {
                    handler(data);
                } catch (error) {
                    logger.logError(error, 'Error in event handler');
                }
            });
        });

        this._botManager.onConnection((data) => {
            this.connectionHandlers.forEach(handler => {
                try {
                    handler(data);
                } catch (error) {
                    logger.logError(error, 'Error in connection handler');
                }
            });
        });

        this._botManager.onError((error, guildId) => {
            this.errorHandlers.forEach(handler => {
                try {
                    handler(error, guildId);
                } catch (handlerError) {
                    logger.logError(handlerError, 'Error in error handler');
                }
            });
        });
    }

    // Public event registration methods
    onMessage(callback) {
        this.messageHandlers.push(callback);
    }

    onEvent(callback) {
        this.eventHandlers.push(callback);
    }

    onConnection(callback) {
        this.connectionHandlers.push(callback);
    }

    onError(callback) {
        this.errorHandlers.push(callback);
    }

    // Public methods for sending messages/commands
    async sendMessage(guildId, message) {
        if (!this._isStarted || !this._botManager) {
            throw new Error('MinecraftManager not started');
        }

        return this._botManager.sendMessage(guildId, message);
    }

    async executeCommand(guildId, command) {
        if (!this._isStarted || !this._botManager) {
            throw new Error('MinecraftManager not started');
        }

        return this._botManager.executeCommand(guildId, command);
    }

    // Status methods
    getConnectionStatus() {
        if (!this._botManager) {
            return {};
        }

        return this._botManager.getConnectionStatus();
    }

    isGuildConnected(guildId) {
        if (!this._botManager) {
            return false;
        }

        return this._botManager.isGuildConnected(guildId);
    }

    getConnectedGuilds() {
        if (!this._botManager) {
            return [];
        }

        return this._botManager.getConnectedGuilds();
    }
}

module.exports = MinecraftManager;