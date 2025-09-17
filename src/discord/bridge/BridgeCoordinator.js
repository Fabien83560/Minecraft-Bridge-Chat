// Specific Imports
const BridgeLocator = require("../../bridgeLocator.js");
const logger = require("../../shared/logger");

class BridgeCoordinator {
    constructor() {
        const mainBridge = BridgeLocator.getInstance();
        this.config = mainBridge.config;

        this.bridgeConfig = this.config.get('bridge');
        
        // References to managers
        this.discordManager = null;
        this.minecraftManager = null;

        // Message routing configuration
        this.routingConfig = {
            guildChatToDiscord: true,
            officerChatToDiscord: true,
            eventsToDiscord: true,
            discordToMinecraft: false, // Disabled for now
            systemMessagesToDiscord: true
        };

        // Statistics
        this.stats = {
            minecraftToDiscord: {
                guildMessages: 0,
                officerMessages: 0,
                events: 0,
                systemMessages: 0,
                errors: 0
            },
            discordToMinecraft: {
                messages: 0,
                errors: 0
            },
            totalProcessed: 0,
            totalErrors: 0
        };

        logger.debug('BridgeCoordinator initialized');
    }

    /**
     * Initialize coordinator with manager references
     * @param {object} discordManager - Discord manager instance
     * @param {object} minecraftManager - Minecraft manager instance
     */
    initialize(discordManager, minecraftManager) {
        this.discordManager = discordManager;
        this.minecraftManager = minecraftManager;

        this.setupMinecraftToDiscordBridge();
        // this.setupDiscordToMinecraftBridge(); // Disabled for now

        logger.bridge('BridgeCoordinator initialized with manager references');
    }

    /**
     * Setup Minecraft to Discord message bridging
     */
    setupMinecraftToDiscordBridge() {
        if (!this.minecraftManager) {
            logger.warn('Minecraft manager not available for bridge setup');
            return;
        }

        // Handle Minecraft messages
        this.minecraftManager.onMessage((messageData) => {
            this.handleMinecraftMessage(messageData);
        });

        // Handle Minecraft events
        this.minecraftManager.onEvent((eventData) => {
            this.handleMinecraftEvent(eventData);
        });

        // Handle Minecraft connection events
        this.minecraftManager.onConnection((connectionData) => {
            this.handleMinecraftConnection(connectionData);
        });

        logger.bridge('✅ Minecraft to Discord bridge setup completed');
    }

    /**
     * Setup Discord to Minecraft message bridging (for future implementation)
     */
    setupDiscordToMinecraftBridge() {
        if (!this.discordManager) {
            logger.warn('Discord manager not available for bridge setup');
            return;
        }

        // Handle Discord messages (for future implementation)
        this.discordManager.onMessage((messageData) => {
            this.handleDiscordMessage(messageData);
        });

        logger.bridge('✅ Discord to Minecraft bridge setup completed');
    }

    // ==================== MINECRAFT TO DISCORD HANDLERS ====================

    /**
     * Handle Minecraft guild message
     * @param {object} messageData - Parsed guild message data
     */
    async handleMinecraftMessage(messageData) {
        try {
            // Skip if Discord bridging is disabled
            if (!this.routingConfig.guildChatToDiscord && messageData.chatType === 'guild') {
                return;
            }
            if (!this.routingConfig.officerChatToDiscord && messageData.chatType === 'officer') {
                return;
            }

            // Get guild configuration
            const guildConfig = this.getGuildConfig(messageData.guildId);
            if (!guildConfig) {
                logger.warn(`Guild configuration not found for message: ${messageData.guildId}`);
                return;
            }

            logger.bridge(`[MC→DC] Processing ${messageData.chatType || 'guild'} message from ${guildConfig.name}: ${messageData.username} -> "${messageData.message}"`);

            // Send to Discord
            await this.discordManager.sendGuildMessage(messageData, guildConfig);

            // Update statistics
            if (messageData.chatType === 'officer') {
                this.stats.minecraftToDiscord.officerMessages++;
            } else {
                this.stats.minecraftToDiscord.guildMessages++;
            }
            
            this.stats.totalProcessed++;

        } catch (error) {
            this.stats.minecraftToDiscord.errors++;
            this.stats.totalErrors++;
            logger.logError(error, `Error bridging Minecraft message to Discord from guild ${messageData.guildId}`);
        }
    }

    /**
     * Handle Minecraft guild event
     * @param {object} eventData - Parsed guild event data
     */
    async handleMinecraftEvent(eventData) {
        try {
            // Skip if event bridging is disabled
            if (!this.routingConfig.eventsToDiscord) {
                return;
            }

            // Get guild configuration
            const guildConfig = this.getGuildConfig(eventData.guildId);
            if (!guildConfig) {
                logger.warn(`Guild configuration not found for event: ${eventData.guildId}`);
                return;
            }

            logger.bridge(`[MC→DC] Processing ${eventData.type} event from ${guildConfig.name}: ${eventData.username || 'system'}`);

            // Send to Discord
            await this.discordManager.sendGuildEvent(eventData, guildConfig);

            // Update statistics
            this.stats.minecraftToDiscord.events++;
            this.stats.totalProcessed++;

        } catch (error) {
            this.stats.minecraftToDiscord.errors++;
            this.stats.totalErrors++;
            logger.logError(error, `Error bridging Minecraft event to Discord from guild ${eventData.guildId}`);
        }
    }

    /**
     * Handle Minecraft connection status
     * @param {object} connectionData - Connection status data
     */
    async handleMinecraftConnection(connectionData) {
        try {
            // Skip if system messages bridging is disabled
            if (!this.routingConfig.systemMessagesToDiscord) {
                return;
            }

            logger.bridge(`[MC→DC] Processing connection status: ${connectionData.type} for ${connectionData.guildName || connectionData.guildId}`);

            // Send connection status to Discord
            await this.discordManager.sendConnectionStatus(
                connectionData.guildId,
                connectionData.type,
                {
                    reason: connectionData.reason,
                    username: connectionData.username,
                    connectionTime: connectionData.connectionTime,
                    attempt: connectionData.attempt
                }
            );

            // Update statistics
            this.stats.minecraftToDiscord.systemMessages++;
            this.stats.totalProcessed++;

        } catch (error) {
            this.stats.minecraftToDiscord.errors++;
            this.stats.totalErrors++;
            logger.logError(error, `Error bridging Minecraft connection status to Discord for guild ${connectionData.guildId}`);
        }
    }

    // ==================== DISCORD TO MINECRAFT HANDLERS ====================

    /**
     * Handle Discord bridge message (for future implementation)
     * @param {object} messageData - Discord message data
     */
    async handleDiscordMessage(messageData) {
        try {
            // This feature is disabled for now
            if (!this.routingConfig.discordToMinecraft) {
                return;
            }

            logger.bridge(`[DC→MC] Processing Discord message from ${messageData.data.author.username} in ${messageData.channel} channel`);

            // TODO: Implement Discord to Minecraft messaging
            // This would require:
            // 1. Parsing Discord message
            // 2. Formatting for Minecraft
            // 3. Sending to appropriate guild(s)
            // 4. Handling permissions and validation

            this.stats.discordToMinecraft.messages++;
            this.stats.totalProcessed++;

        } catch (error) {
            this.stats.discordToMinecraft.errors++;
            this.stats.totalErrors++;
            logger.logError(error, 'Error bridging Discord message to Minecraft');
        }
    }

    // ==================== UTILITY METHODS ====================

    /**
     * Get guild configuration by ID
     * @param {string} guildId - Guild ID
     * @returns {object|null} Guild configuration or null
     */
    getGuildConfig(guildId) {
        const enabledGuilds = this.config.getEnabledGuilds();
        return enabledGuilds.find(guild => guild.id === guildId) || null;
    }

    /**
     * Send system message to Discord
     * @param {string} type - System message type
     * @param {string} message - System message content
     * @param {object} details - Additional details
     * @param {string} channelType - Target channel type (chat/staff)
     */
    async sendSystemMessage(type, message, details = {}, channelType = 'chat') {
        try {
            if (!this.discordManager || !this.routingConfig.systemMessagesToDiscord) {
                return;
            }

            // Create system message data
            const systemData = {
                message: message,
                details: details,
                context: type,
                timestamp: Date.now()
            };

            // Use first enabled guild as default for system messages
            const guildConfig = this.config.getEnabledGuilds()[0];
            if (!guildConfig) {
                logger.warn('No guild configuration available for system message');
                return;
            }

            logger.bridge(`[SYSTEM→DC] Sending system message to ${channelType} channel: ${message}`);

            await this.discordManager.sendSystemMessage(type, systemData, guildConfig, channelType);

            this.stats.minecraftToDiscord.systemMessages++;
            this.stats.totalProcessed++;

        } catch (error) {
            this.stats.minecraftToDiscord.errors++;
            this.stats.totalErrors++;
            logger.logError(error, 'Error sending system message to Discord');
        }
    }

    /**
     * Send test message for debugging
     * @param {string} content - Test message content
     * @param {string} channelType - Target channel type
     * @returns {Promise} Test result
     */
    async sendTestMessage(content = 'Test message from BridgeCoordinator', channelType = 'chat') {
        try {
            const guildConfig = this.config.getEnabledGuilds()[0];
            if (!guildConfig) {
                throw new Error('No guild configuration available for test message');
            }

            // Create test message data
            const testMessageData = {
                type: 'guild_chat',
                chatType: 'guild',
                username: 'TestUser',
                message: content,
                guildId: guildConfig.id,
                guildName: guildConfig.name,
                guildTag: guildConfig.tag,
                timestamp: Date.now(),
                parsedSuccessfully: true
            };

            logger.bridge(`[TEST→DC] Sending test message to ${channelType} channel: "${content}"`);

            await this.discordManager.sendGuildMessage(testMessageData, guildConfig);

            return {
                success: true,
                message: 'Test message sent successfully',
                channelType: channelType,
                content: content
            };

        } catch (error) {
            logger.logError(error, 'Error sending test message to Discord');
            return {
                success: false,
                error: error.message,
                channelType: channelType
            };
        }
    }

    /**
     * Update routing configuration
     * @param {object} newConfig - New routing configuration
     */
    updateRoutingConfig(newConfig) {
        this.routingConfig = { ...this.routingConfig, ...newConfig };
        logger.bridge('BridgeCoordinator routing configuration updated:', this.routingConfig);
    }

    /**
     * Get bridge statistics
     * @returns {object} Bridge statistics
     */
    getStatistics() {
        return {
            ...this.stats,
            routingConfig: this.routingConfig,
            managersAvailable: {
                discord: !!this.discordManager,
                minecraft: !!this.minecraftManager
            },
            successRate: this.stats.totalProcessed > 0 ? 
                ((this.stats.totalProcessed - this.stats.totalErrors) / this.stats.totalProcessed * 100).toFixed(2) + '%' : '0%'
        };
    }

    /**
     * Reset statistics
     */
    resetStatistics() {
        this.stats = {
            minecraftToDiscord: {
                guildMessages: 0,
                officerMessages: 0,
                events: 0,
                systemMessages: 0,
                errors: 0
            },
            discordToMinecraft: {
                messages: 0,
                errors: 0
            },
            totalProcessed: 0,
            totalErrors: 0
        };

        logger.debug('BridgeCoordinator statistics reset');
    }

    /**
     * Check if bridge is operational
     * @returns {object} Bridge status
     */
    getStatus() {
        const status = {
            operational: false,
            discord: {
                available: !!this.discordManager,
                connected: this.discordManager ? this.discordManager.isConnected() : false
            },
            minecraft: {
                available: !!this.minecraftManager,
                connections: this.minecraftManager ? this.minecraftManager.getConnectedGuilds().length : 0
            },
            routing: this.routingConfig
        };

        status.operational = status.discord.connected && status.minecraft.connections > 0;

        return status;
    }

    /**
     * Enable/disable specific routing
     * @param {string} routingType - Routing type to toggle
     * @param {boolean} enabled - Whether to enable or disable
     */
    setRouting(routingType, enabled) {
        if (this.routingConfig.hasOwnProperty(routingType)) {
            this.routingConfig[routingType] = enabled;
            logger.bridge(`${routingType} routing ${enabled ? 'enabled' : 'disabled'}`);
        } else {
            logger.warn(`Unknown routing type: ${routingType}`);
        }
    }

    /**
     * Cleanup resources
     */
    cleanup() {
        // Clear references
        this.discordManager = null;
        this.minecraftManager = null;

        // Reset statistics
        this.resetStatistics();

        logger.debug('BridgeCoordinator cleaned up');
    }
}

module.exports = BridgeCoordinator;