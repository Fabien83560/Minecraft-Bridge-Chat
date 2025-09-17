// Specific Imports
const BridgeLocator = require("../bridgeLocator.js");
const DiscordBot = require("./client/DiscordBot.js");
const MessageSender = require("./client/senders/MessageSender.js");
const logger = require("../shared/logger");

class DiscordManager {
    constructor() {
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

            // Start Discord bot
            await this._discordBot.start();

            // Initialize message sender with bot client
            await this._messageSender.initialize(this._discordBot.getClient());

            // Setup event forwarding
            this.setupEventForwarding();

            this._isStarted = true;
            logger.discord('✅ Discord connections started successfully');

        } catch (error) {
            logger.logError(error, 'Failed to start Discord connections');
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
            throw new Error('DiscordManager not started');
        }

        try {
            // Determine target channel based on chat type
            const channelType = messageData.chatType === 'officer' ? 'staff' : 'chat';
            
            logger.bridge(`[DISCORD] Sending ${messageData.chatType || 'guild'} message from ${guildConfig.name} to ${channelType} channel`);

            return await this._messageSender.sendGuildMessage(messageData, guildConfig, channelType);

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
            throw new Error('DiscordManager not started');
        }

        try {
            logger.bridge(`[DISCORD] Sending ${eventData.type} event from ${guildConfig.name} to chat channel`);

            return await this._messageSender.sendGuildEvent(eventData, guildConfig, 'chat');

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
            throw new Error('DiscordManager not started');
        }

        try {
            logger.bridge(`[DISCORD] Sending system message ${type} from ${guildConfig.name} to ${channelType} channel`);

            return await this._messageSender.sendSystemMessage(type, data, guildConfig, channelType);

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
            logger.debug('DiscordManager not started, skipping connection status');
            return;
        }

        try {
            const guildConfig = this.config.getEnabledGuilds().find(g => g.id === guildId);
            if (!guildConfig) {
                logger.warn(`Guild config not found for ID: ${guildId}`);
                return;
            }

            logger.bridge(`[DISCORD] Sending connection status for ${guildConfig.name}: ${status}`);

            return await this._messageSender.sendConnectionStatus(status, guildConfig, details);

        } catch (error) {
            logger.logError(error, `Failed to send connection status to Discord for guild ${guildId}`);
        }
    }

    // ==================== EVENT REGISTRATION METHODS ====================

    onMessage(callback) {
        this.messageHandlers.push(callback);
    }

    onConnection(callback) {
        this.connectionHandlers.push(callback);
    }

    onError(callback) {
        this.errorHandlers.push(callback);
    }

    // ==================== STATUS METHODS ====================

    isConnected() {
        return this._discordBot ? this._discordBot.isConnected() : false;
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
}

module.exports = DiscordManager;