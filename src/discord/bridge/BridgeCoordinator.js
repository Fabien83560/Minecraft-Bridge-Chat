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
            totalErrors: 0,
            lastMessageTime: null,
            lastEventTime: null
        };

        logger.debug('BridgeCoordinator initialized');
    }

    /**
     * Initialize coordinator with manager references
     * @param {object} discordManager - Discord manager instance
     * @param {object} minecraftManager - Minecraft manager instance
     */
    initialize(discordManager, minecraftManager) {
        logger.debug('[BRIDGE] BridgeCoordinator.initialize called');
        
        this.discordManager = discordManager;
        this.minecraftManager = minecraftManager;

        logger.debug(`[BRIDGE] Managers set - Discord: ${!!discordManager}, Minecraft: ${!!minecraftManager}`);

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

        if (!this.discordManager) {
            logger.warn('Discord manager not available for bridge setup');
            return;
        }

        logger.debug('[BRIDGE] Setting up Minecraft to Discord event handlers...');

        // Handle Minecraft messages
        this.minecraftManager.onMessage((messageData) => {
            logger.debug(`[BRIDGE] Received Minecraft message event: ${JSON.stringify(messageData)}`);
            this.handleMinecraftMessage(messageData);
        });

        // Handle Minecraft events
        this.minecraftManager.onEvent((eventData) => {
            logger.debug(`[BRIDGE] Received Minecraft event: ${JSON.stringify(eventData)}`);
            this.handleMinecraftEvent(eventData);
        });

        // Handle Minecraft connection events
        this.minecraftManager.onConnection((connectionData) => {
            logger.debug(`[BRIDGE] Received Minecraft connection event: ${JSON.stringify(connectionData)}`);
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
            logger.debug(`[BRIDGE] Received Discord message event: ${JSON.stringify(messageData)}`);
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
            logger.debug(`[MC→DC] Processing message: ${JSON.stringify(messageData)}`);
            const guilds = this.config.getEnabledGuilds().filter(guild => guild.account.username === messageData.username);
            if(guilds.length !== 0)
                return;
            
            // Skip if Discord bridging is disabled
            if (!this.routingConfig.guildChatToDiscord && messageData.chatType === 'guild') {
                logger.debug(`[MC→DC] Guild chat bridging disabled, skipping message`);
                return;
            }
            if (!this.routingConfig.officerChatToDiscord && messageData.chatType === 'officer') {
                logger.debug(`[MC→DC] Officer chat bridging disabled, skipping message`);
                return;
            }

            // Get guild configuration
            const guildConfig = this.getGuildConfig(messageData.guildId);
            if (!guildConfig) {
                logger.warn(`Guild configuration not found for message: ${messageData.guildId}`);
                return;
            }

            logger.discord(`[MC→DC] Processing ${messageData.chatType || 'guild'} message from ${guildConfig.name}: ${messageData.username} -> "${messageData.message}"`);

            // Check if Discord manager is ready
            if (!this.discordManager.isConnected()) {
                logger.warn(`[MC→DC] Discord not connected, skipping message`);
                return;
            }

            // Send to Discord
            logger.debug(`[MC→DC] Sending message to Discord...`);
            const result = await this.discordManager.sendGuildMessage(messageData, guildConfig);
            logger.debug(`[MC→DC] Discord send result: ${JSON.stringify(result)}`);

            // Update statistics
            if (messageData.chatType === 'officer') {
                this.stats.minecraftToDiscord.officerMessages++;
            } else {
                this.stats.minecraftToDiscord.guildMessages++;
            }
            
            this.stats.totalProcessed++;
            this.stats.lastMessageTime = Date.now();

            logger.discord(`[MC→DC] ✅ Message successfully bridged to Discord`);

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
            logger.debug(`[MC→DC] Processing event: ${JSON.stringify(eventData)}`);
            
            // Skip if event bridging is disabled
            if (!this.routingConfig.eventsToDiscord) {
                logger.debug(`[MC→DC] Event bridging disabled, skipping event`);
                return;
            }

            // Get guild configuration
            const guildConfig = this.getGuildConfig(eventData.guildId);
            if (!guildConfig) {
                logger.warn(`Guild configuration not found for event: ${eventData.guildId}`);
                return;
            }

            logger.discord(`[MC→DC] Processing ${eventData.type} event from ${guildConfig.name}: ${eventData.username || 'system'}`);

            // Check if Discord manager is ready
            if (!this.discordManager.isConnected()) {
                logger.warn(`[MC→DC] Discord not connected, skipping event`);
                return;
            }

            // Send to Discord
            logger.debug(`[MC→DC] Sending event to Discord...`);
            const result = await this.discordManager.sendGuildEvent(eventData, guildConfig);
            logger.debug(`[MC→DC] Discord event send result: ${JSON.stringify(result)}`);

            // Update statistics
            this.stats.minecraftToDiscord.events++;
            this.stats.totalProcessed++;
            this.stats.lastEventTime = Date.now();

            logger.discord(`[MC→DC] ✅ Event successfully bridged to Discord`);

        } catch (error) {
            this.stats.minecraftToDiscord.errors++;
            this.stats.totalErrors++;
            logger.logError(error, `Error bridging Minecraft event to Discord from guild ${eventData.guildId}`);
        }
    }

    /**
     * Handle Minecraft connection events
     * @param {object} connectionData - Connection event data
     */
    async handleMinecraftConnection(connectionData) {
        try {
            logger.debug(`[MC→DC] Processing connection event: ${JSON.stringify(connectionData)}`);
            
            // Skip if system message bridging is disabled
            if (!this.routingConfig.systemMessagesToDiscord) {
                logger.debug(`[MC→DC] System message bridging disabled, skipping connection event`);
                return;
            }

            const guildId = connectionData.guildId || connectionData.guild;
            if (!guildId) {
                logger.warn(`No guild ID found in connection data`);
                return;
            }

            // Get guild configuration
            const guildConfig = this.getGuildConfig(guildId);
            if (!guildConfig) {
                logger.warn(`Guild configuration not found for connection event: ${guildId}`);
                return;
            }

            logger.discord(`[MC→DC] Processing connection ${connectionData.type} for ${guildConfig.name}`);

            // Check if Discord manager is ready
            if (!this.discordManager.isConnected()) {
                logger.warn(`[MC→DC] Discord not connected, skipping connection event`);
                return;
            }

            // Send connection status to Discord
            logger.debug(`[MC→DC] Sending connection status to Discord...`);
            const result = await this.discordManager.sendConnectionStatus(
                connectionData.type, 
                guildConfig, 
                connectionData
            );
            logger.debug(`[MC→DC] Discord connection status send result: ${JSON.stringify(result)}`);

            // Update statistics
            this.stats.minecraftToDiscord.systemMessages++;
            this.stats.totalProcessed++;

            logger.discord(`[MC→DC] ✅ Connection event successfully bridged to Discord`);

        } catch (error) {
            this.stats.minecraftToDiscord.errors++;
            this.stats.totalErrors++;
            logger.logError(error, `Error bridging Minecraft connection event to Discord`);
        }
    }

    // ==================== DISCORD TO MINECRAFT HANDLERS (FUTURE) ====================

    /**
     * Handle Discord message (for future implementation)
     * @param {object} messageData - Discord message data
     */
    async handleDiscordMessage(messageData) {
        // Future implementation for Discord to Minecraft bridging
        logger.debug(`[DC→MC] Discord message received (not implemented): ${JSON.stringify(messageData)}`);
    }

    // ==================== UTILITY METHODS ====================

    /**
     * Get guild configuration by ID
     * @param {string} guildId - Guild ID
     * @returns {object|null} Guild configuration
     */
    getGuildConfig(guildId) {
        const guilds = this.config.getEnabledGuilds();
        return guilds.find(guild => guild.id === guildId) || null;
    }

    /**
     * Get coordinator statistics
     * @returns {object} Statistics object
     */
    getStatistics() {
        return {
            ...this.stats,
            routing: this.routingConfig,
            managers: {
                discord: !!this.discordManager,
                minecraft: !!this.minecraftManager,
                discordConnected: this.discordManager ? this.discordManager.isConnected() : false
            },
            uptime: process.uptime()
        };
    }

    /**
     * Update routing configuration
     * @param {object} newConfig - New routing configuration
     */
    updateRoutingConfig(newConfig) {
        this.routingConfig = { ...this.routingConfig, ...newConfig };
        logger.bridge('BridgeCoordinator routing configuration updated');
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
            totalErrors: 0,
            lastMessageTime: null,
            lastEventTime: null
        };
        
        logger.bridge('BridgeCoordinator statistics reset');
    }

    /**
     * Cleanup resources
     */
    cleanup() {
        this.discordManager = null;
        this.minecraftManager = null;
        
        logger.debug('BridgeCoordinator cleaned up');
    }
}

module.exports = BridgeCoordinator;