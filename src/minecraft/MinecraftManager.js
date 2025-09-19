// Globals Imports
const fs = require('fs');

// Specific Imports
const BridgeCoordinator = require('../discord/bridge/BridgeCoordinator.js');
const BotManager = require("./client/BotManager.js")
const BridgeLocator = require("../bridgeLocator.js");
const logger = require('../shared/logger/index.js');

class MinecraftManager {
    constructor() {
        const mainBridge = BridgeLocator.getInstance();
        this.config = mainBridge.config;

        this._isInitialized = false;
        this._isStarted = false;
        this._botManager = null;
        
        // Discord integration
        this._discordManager = null;
        this._bridgeCoordinator = null;

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
            
            // Setup event forwarding first
            this.setupEventForwarding();
            
            // NOTE: Discord integration will be setup later via setDiscordManager()
            // called from main.js setupCrossManagerIntegration()
            
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
            
            // Cleanup bridge coordinator
            if (this._bridgeCoordinator) {
                this._bridgeCoordinator.cleanup();
                this._bridgeCoordinator = null;
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
            logger.debug(`[MINECRAFT] Message event forwarded: ${data.username} -> "${data.message}"`);
            
            this.messageHandlers.forEach(handler => {
                try {
                    handler(data);
                } catch (error) {
                    logger.logError(error, 'Error in message handler');
                }
            });
        });

        this._botManager.onEvent((data) => {
            logger.debug(`[MINECRAFT] Event forwarded: ${data.type} for ${data.username || 'system'}`);
            
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

    /**
     * Setup Discord integration (called during startup - may not succeed initially)
     * This is kept for backward compatibility but now relies on setDiscordManager()
     */
    setupDiscordIntegration() {
        try {
            logger.debug('[INTEGRATION] Starting Discord integration setup...');
            
            const mainBridge = BridgeLocator.getInstance();
            logger.debug('[INTEGRATION] Got main bridge instance');
            
            const discordManager = mainBridge.getDiscordManager?.();
            logger.debug(`[INTEGRATION] Discord manager: ${discordManager ? 'Available' : 'Not available'}`);

            if (discordManager) {
                this.setupDiscordIntegrationInternal(discordManager);
            } else {
                logger.debug('[INTEGRATION] Discord manager not available yet, will be set later via setDiscordManager()');
            }
            
        } catch (error) {
            logger.logError(error, 'Failed to setup Discord integration for MinecraftManager');
        }
    }

    /**
     * Set Discord manager reference (called from main bridge)
     * @param {object} discordManager - Discord manager instance
     */
    setDiscordManager(discordManager) {
        logger.debug(`[INTEGRATION] setDiscordManager called with: ${discordManager ? 'valid manager' : 'null'}`);
        
        this._discordManager = discordManager;
        
        if (this._isStarted && discordManager && !this._bridgeCoordinator) {
            logger.debug('[INTEGRATION] Setting up Discord integration via setDiscordManager...');
            this.setupDiscordIntegrationInternal(discordManager);
        } else {
            logger.debug(`[INTEGRATION] Integration conditions not met: started=${this._isStarted}, manager=${!!discordManager}, coordinator=${!!this._bridgeCoordinator}`);
        }
    }

    /**
     * Internal Discord integration setup
     * @param {object} discordManager - Discord manager instance
     */
    setupDiscordIntegrationInternal(discordManager) {
        try {
            logger.debug('[INTEGRATION] Starting internal Discord integration setup...');
            
            if (!discordManager) {
                logger.warn('[INTEGRATION] No Discord manager provided');
                return;
            }

            this._bridgeCoordinator = new BridgeCoordinator();
            logger.debug('[INTEGRATION] BridgeCoordinator created, initializing...');
            
            this._bridgeCoordinator.initialize(discordManager, this);
            logger.bridge('✅ Discord integration setup completed for MinecraftManager');
            logger.debug(`[INTEGRATION] Bridge coordinator stats: ${JSON.stringify(this._bridgeCoordinator.getStatistics())}`);

        } catch (error) {
            logger.logError(error, 'Failed to setup internal Discord integration');
        }
    }

    // Public event registration methods
    onMessage(callback) {
        this.messageHandlers.push(callback);
        logger.debug(`[EVENT] Message handler registered (total: ${this.messageHandlers.length})`);
    }

    onEvent(callback) {
        this.eventHandlers.push(callback);
        logger.debug(`[EVENT] Event handler registered (total: ${this.eventHandlers.length})`);
    }

    onConnection(callback) {
        this.connectionHandlers.push(callback);
        logger.debug(`[EVENT] Connection handler registered (total: ${this.connectionHandlers.length})`);
    }

    onError(callback) {
        this.errorHandlers.push(callback);
        logger.debug(`[EVENT] Error handler registered (total: ${this.errorHandlers.length})`);
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

    // Discord integration methods
    getDiscordManager() {
        return this._discordManager;
    }

    getBridgeCoordinator() {
        return this._bridgeCoordinator;
    }

    getInterGuildStats() {
        if (!this._botManager) {
            return null;
        }

        return this._botManager.getInterGuildStats();
    }

    updateInterGuildConfig(newConfig) {
        if (this._botManager) {
            this._botManager.updateInterGuildConfig(newConfig);
            logger.info('Inter-guild configuration updated via MinecraftManager');
        }
    }

    testMessageFormatting(testData) {
        if (!this._botManager) {
            return { error: 'BotManager not available' };
        }

        return this._botManager.testInterGuildFormatting(testData);
    }

    clearInterGuildCache() {
        if (this._botManager) {
            this._botManager.clearInterGuildCache();
            logger.info('Inter-guild cache cleared via MinecraftManager');
        }
    }

    /**
     * Get debugging information
     */
    getDebugInfo() {
        return {
            isInitialized: this._isInitialized,
            isStarted: this._isStarted,
            hasDiscordManager: !!this._discordManager,
            hasBridgeCoordinator: !!this._bridgeCoordinator,
            messageHandlers: this.messageHandlers.length,
            eventHandlers: this.eventHandlers.length,
            connectionHandlers: this.connectionHandlers.length,
            errorHandlers: this.errorHandlers.length,
            bridgeCoordinatorStats: this._bridgeCoordinator ? this._bridgeCoordinator.getStatistics() : null
        };
    }
}

module.exports = MinecraftManager;