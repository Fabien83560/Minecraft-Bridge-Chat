// Globals Imports
const EventEmitter = require('events');

// Specific Imports
const BridgeLocator = require("../bridgeLocator.js");
const DiscordBot = require("./client/DiscordBot.js");
const MessageSender = require("./client/senders/MessageSender.js");
const logger = require("../shared/logger");

class DiscordManager extends EventEmitter {
    constructor() {
        super();
        
        const mainBridge = BridgeLocator.getInstance();
        this.config = mainBridge.config;

        this._isInitialized = false;
        this._isStarted = false;
        this._discordBot = null;
        this._messageSender = null;

        // Event handlers
        this.messageHandlers = [];
        this.eventHandlers = [];
        this.connectionHandlers = [];
        this.errorHandlers = [];

        this.initialize();
    }

    async initialize() {
        if (this._isInitialized) {
            logger.warn("DiscordManager already initialized");
            return;
        }

        try {
            logger.discord("Initializing Discord module...");

            // Validate configuration
            this.validateConfiguration();

            // Initialize Discord bot
            this._discordBot = new DiscordBot();

            // Initialize message sender
            this._messageSender = new MessageSender();

            this._isInitialized = true;
            logger.discord("✅ Discord module initialized");

        } catch (error) {
            logger.logError(error, 'Failed to initialize Discord module');
            throw error;
        }
    }

    async start() {
        if (!this._isInitialized) {
            throw new Error('DiscordManager must be initialized before starting');
        }

        if (this._isStarted) {
            logger.warn('DiscordManager already started');
            return;
        }

        try {
            logger.discord('Starting Discord connections...');

            // Step 1: Start Discord bot and wait for it to be ready
            logger.debug('[DISCORD] Starting bot...');
            await this._discordBot.start();

            // Step 2: Wait a bit more to ensure bot is fully authenticated
            await new Promise(resolve => setTimeout(resolve, 1000));

            // Step 3: Check if bot is actually connected and ready
            if (!this._discordBot.isConnected()) {
                logger.debug('[DISCORD] Bot connection check failed, attempting to reconnect...');
                // Try to restart the bot
                await this._discordBot.stop();
                await new Promise(resolve => setTimeout(resolve, 2000)); // Wait 2 seconds
                await this._discordBot.start();
                
                if (!this._discordBot.isConnected()) {
                    throw new Error('Discord bot failed to connect after restart attempt');
                }
            }

            logger.debug('[DISCORD] Bot connected, initializing message sender...');

            // Step 4: Initialize message sender with the ready client
            await this._messageSender.initialize(this._discordBot.getClient());

            logger.debug('[DISCORD] Message sender initialized, setting up event forwarding...');

            // Step 5: Setup event forwarding
            this.setupEventForwarding();

            this._isStarted = true;
            logger.discord('✅ Discord connections started successfully');

        } catch (error) {
            logger.logError(error, 'Failed to start Discord connections');
            
            // Provide helpful error messages for common issues
            if (error.message.includes('Expected token to be set') || 
                error.message.includes('token')) {
                logger.error('❌ Discord token is not configured properly!');
                logger.error('   Please check your config/settings.json file');
                logger.error('   Make sure you have set a valid Discord bot token');
            }
            
            throw error;
        }
    }

    async stop() {
        if (!this._isStarted) {
            logger.debug('DiscordManager not started, nothing to stop');
            return;
        }

        try {
            logger.discord('Stopping Discord connections...');

            if (this._discordBot) {
                await this._discordBot.stop();
            }

            if (this._messageSender) {
                this._messageSender.cleanup();
            }

            this._isStarted = false;
            logger.discord('✅ Discord connections stopped');

        } catch (error) {
            logger.logError(error, 'Error stopping Discord connections');
            throw error;
        }
    }

    setupEventForwarding() {
        // Forward Discord bot events to external handlers
        this._discordBot.onMessage((data) => {
            this.messageHandlers.forEach(handler => {
                try {
                    handler(data);
                } catch (error) {
                    logger.logError(error, 'Error in Discord message handler');
                }
            });
        });

        this._discordBot.onConnection((data) => {
            this.connectionHandlers.forEach(handler => {
                try {
                    handler(data);
                } catch (error) {
                    logger.logError(error, 'Error in Discord connection handler');
                }
            });
        });

        this._discordBot.onError((error) => {
            this.errorHandlers.forEach(handler => {
                try {
                    handler(error);
                } catch (handlerError) {
                    logger.logError(handlerError, 'Error in Discord error handler');
                }
            });
        });
    }

    validateConfiguration() {
        const appConfig = this.config.get('app');
        const bridgeConfig = this.config.get('bridge');

        if (!appConfig.token) {
            throw new Error('Discord bot token is required');
        }

        if (!appConfig.clientId) {
            throw new Error('Discord bot client ID is required');
        }

        if (!bridgeConfig.channels) {
            throw new Error('Discord bridge channels configuration is required');
        }

        if (!bridgeConfig.channels.chat || !bridgeConfig.channels.chat.id) {
            throw new Error('Discord chat channel ID is required');
        }

        if (!bridgeConfig.channels.staff || !bridgeConfig.channels.staff.id) {
            throw new Error('Discord staff channel ID is required');
        }

        logger.debug('Discord configuration validated successfully');
    }

    // ==================== MESSAGE SENDING METHODS ====================

    /**
     * Send guild chat message to Discord
     * @param {object} messageData - Parsed guild message data
     * @param {object} guildConfig - Guild configuration
     * @returns {Promise} Send promise
     */
    async sendGuildMessage(messageData, guildConfig) {
        if (!this._isStarted || !this._messageSender) {
            logger.debug('[DISCORD] Manager not started, skipping guild message');
            throw new Error('DiscordManager not started');
        }

        try {
            logger.debug(`[DISCORD] sendGuildMessage called - Guild: ${guildConfig.name}, User: ${messageData.username}, Message: "${messageData.message}"`);

            // Send the message
            const result = await this._messageSender.sendGuildMessage(messageData, guildConfig);

            logger.discord(`[DISCORD] ✅ Guild message sent successfully from ${guildConfig.name}`);
            return result;

        } catch (error) {
            logger.logError(error, `Failed to send guild message to Discord from ${guildConfig.name}`);
            throw error;
        }
    }

    /**
     * Send guild event to Discord
     * @param {object} eventData - Parsed event data
     * @param {object} guildConfig - Guild configuration
     * @returns {Promise} Send promise
     */
    async sendGuildEvent(eventData, guildConfig) {
        if (!this._isStarted || !this._messageSender) {
            logger.debug('[DISCORD] Manager not started, skipping guild event');
            throw new Error('DiscordManager not started');
        }

        try {
            logger.debug(`[DISCORD] sendGuildEvent called - Guild: ${guildConfig.name}, Event: ${eventData.type}, User: ${eventData.username || 'system'}`);

            // Send the event
            const result = await this._messageSender.sendEvent(eventData, guildConfig);

            logger.discord(`[DISCORD] ✅ Guild event sent successfully from ${guildConfig.name}`);
            return result;

        } catch (error) {
            logger.logError(error, `Failed to send guild event to Discord from ${guildConfig.name}`);
            throw error;
        }
    }

    /**
     * Send system message to Discord
     * @param {string} type - System message type
     * @param {object} data - System message data
     * @param {object} guildConfig - Guild configuration
     * @param {string} channelType - Channel type (chat/staff)
     * @returns {Promise} Send promise
     */
    async sendSystemMessage(type, data, guildConfig, channelType = 'chat') {
        if (!this._isStarted || !this._messageSender) {
            logger.debug('[DISCORD] Manager not started, skipping system message');
            throw new Error('DiscordManager not started');
        }

        try {
            logger.debug(`[DISCORD] sendSystemMessage called - Type: ${type}, Guild: ${guildConfig.name}, Channel: ${channelType}`);

            // Send the system message
            const result = await this._messageSender.sendSystemMessage(type, data, channelType);

            logger.discord(`[DISCORD] ✅ System message sent successfully from ${guildConfig.name}`);
            return result;

        } catch (error) {
            logger.logError(error, `Failed to send system message to Discord from ${guildConfig.name}`);
            throw error;
        }
    }

    /**
     * Send connection status to Discord
     * @param {string} guildId - Guild ID
     * @param {string} status - Connection status  
     * @param {object} details - Additional details
     * @returns {Promise} Send promise
     */
    async sendConnectionStatus(guildId, status, details = {}) {
        if (!this._isStarted || !this._messageSender) {
            logger.debug('[DISCORD] Manager not started, skipping connection status');
            return;
        }

        try {
            const guildConfig = this.config.getEnabledGuilds().find(g => g.id === guildId);
            if (!guildConfig) {
                logger.warn(`Guild config not found for ID: ${guildId}`);
                return;
            }

            logger.debug(`[DISCORD] sendConnectionStatus called - Guild: ${guildConfig.name}, Status: ${status}`);

            // Send the connection status
            const result = await this._messageSender.sendConnectionStatus(status, guildConfig, details);

            logger.discord(`[DISCORD] ✅ Connection status sent successfully for ${guildConfig.name}: ${status}`);
            return result;

        } catch (error) {
            logger.logError(error, `Failed to send connection status to Discord for guild ${guildId}`);
        }
    }

    // ==================== EVENT REGISTRATION METHODS ====================

    onMessage(callback) {
        this.messageHandlers.push(callback);
        logger.debug(`[DISCORD] Message handler registered (total: ${this.messageHandlers.length})`);
    }

    onConnection(callback) {
        this.connectionHandlers.push(callback);
        logger.debug(`[DISCORD] Connection handler registered (total: ${this.connectionHandlers.length})`);
    }

    onError(callback) {
        this.errorHandlers.push(callback);
        logger.debug(`[DISCORD] Error handler registered (total: ${this.errorHandlers.length})`);
    }

    // ==================== STATUS METHODS ====================

    isConnected() {
        const connected = this._discordBot ? this._discordBot.isConnected() : false;
        logger.debug(`[DISCORD] Connection status checked: ${connected}`);
        return connected;
    }

    getConnectionStatus() {
        if (!this._discordBot) {
            return {
                connected: false,
                ready: false,
                error: 'Discord bot not initialized'
            };
        }

        return this._discordBot.getConnectionStatus();
    }

    getBotInfo() {
        if (!this._discordBot) {
            return null;
        }

        return this._discordBot.getBotInfo();
    }

    // ==================== UTILITY METHODS ====================

    /**
     * Get Discord client (for advanced usage)
     * @returns {Client} Discord client instance
     */
    getClient() {
        return this._discordBot ? this._discordBot.getClient() : null;
    }

    /**
     * Get message sender (for advanced usage)
     * @returns {MessageSender} Message sender instance
     */
    getMessageSender() {
        return this._messageSender;
    }

    /**
     * Test Discord message sending
     * @param {object} testData - Test data
     * @returns {Promise} Test result
     */
    async testMessageSending(testData = {}) {
        if (!this._isStarted || !this._messageSender) {
            return { error: 'Discord not started' };
        }

        const defaultTestData = {
            username: 'TestUser',
            message: 'Test message from Discord system',
            chatType: 'guild',
            type: 'guild_chat'
        };

        const mergedTestData = { ...defaultTestData, ...testData };

        try {
            const testGuildConfig = this.config.getEnabledGuilds()[0];
            if (!testGuildConfig) {
                return { error: 'No guild config found for testing' };
            }

            const result = await this.sendGuildMessage(mergedTestData, testGuildConfig);
            
            return {
                success: true,
                message: 'Test message sent successfully',
                result: result
            };

        } catch (error) {
            logger.logError(error, 'Discord test message failed');
            return {
                success: false,
                error: error.message
            };
        }
    }

    /**
     * Get Discord statistics
     * @returns {object} Discord statistics
     */
    getStatistics() {
        const stats = {
            isInitialized: this._isInitialized,
            isStarted: this._isStarted,
            connected: this.isConnected(),
            bot: null,
            messageSender: null
        };

        if (this._discordBot) {
            stats.bot = this._discordBot.getStatistics();
        }

        if (this._messageSender) {
            stats.messageSender = this._messageSender.getStatistics();
        }

        return stats;
    }

    /**
     * Update Discord configuration
     * @param {object} newConfig - New configuration
     */
    updateConfig(newConfig) {
        // Update configuration would require restart
        logger.warn('Discord configuration update requires restart');
        // For now, just log the request
        logger.debug('Discord config update requested:', newConfig);
    }

    /**
     * Get debugging information
     */
    getDebugInfo() {
        return {
            isInitialized: this._isInitialized,
            isStarted: this._isStarted,
            isConnected: this.isConnected(),
            hasBotInstance: !!this._discordBot,
            hasMessageSender: !!this._messageSender,
            messageHandlers: this.messageHandlers.length,
            connectionHandlers: this.connectionHandlers.length,
            errorHandlers: this.errorHandlers.length,
            botInfo: this.getBotInfo(),
            connectionStatus: this.getConnectionStatus()
        };
    }
}

module.exports = DiscordManager;