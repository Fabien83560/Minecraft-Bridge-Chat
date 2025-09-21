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
            discordToMinecraft: true,
            systemMessagesToDiscord: true
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
        this.setupDiscordToMinecraftBridge();

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
     * Setup Discord to Minecraft message bridging
     */
    setupDiscordToMinecraftBridge() {
        if (!this.discordManager) {
            logger.warn('Discord manager not available for bridge setup');
            return;
        }

        if (!this.minecraftManager) {
            logger.warn('Minecraft manager not available for bridge setup');
            return;
        }

        logger.debug('[BRIDGE] Setting up Discord to Minecraft event handlers...');

        // Handle Discord messages
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

            logger.discord(`[MC→DC] ✅ Message successfully bridged to Discord`);

        } catch (error) {
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

            logger.discord(`[MC→DC] ✅ Event successfully bridged to Discord`);

        } catch (error) {
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

            logger.discord(`[MC→DC] ✅ Connection event successfully bridged to Discord`);

        } catch (error) {
            logger.logError(error, `Error bridging Minecraft connection event to Discord`);
        }
    }

    // ==================== DISCORD TO MINECRAFT HANDLERS (FUTURE) ====================

    /**
     * Handle Discord message and relay to Minecraft
     * @param {object} messageData - Discord message data
     */
    async handleDiscordMessage(messageData) {
        try {
            logger.debug(`[DC→MC] Processing Discord message: ${JSON.stringify(messageData)}`);
            
            // Skip if Discord to Minecraft bridging is disabled
            if (!this.routingConfig.discordToMinecraft) {
                logger.debug(`[DC→MC] Discord to Minecraft bridging disabled, skipping message`);
                return;
            }

            // Validate message data
            if (!messageData || !messageData.content || !messageData.author) {
                logger.debug(`[DC→MC] Invalid message data, skipping`);
                return;
            }

            // Check if Minecraft manager is ready
            if (!this.minecraftManager || !this.minecraftManager._isStarted) {
                logger.warn(`[DC→MC] Minecraft manager not ready, skipping message`);
                return;
            }

            // Determine target chat type based on Discord channel
            const chatType = this.determineChatTypeFromChannel(messageData.channelType);
            if (!chatType) {
                logger.debug(`[DC→MC] Unknown channel type: ${messageData.channelType}, skipping message`);
                return;
            }

            // Get connected Minecraft guilds
            const connectedGuilds = this.minecraftManager.getConnectedGuilds();
            if (!connectedGuilds || connectedGuilds.length === 0) {
                logger.warn(`[DC→MC] No connected Minecraft guilds available`);
                return;
            }

            // Format message for Minecraft
            const formattedMessage = this.formatDiscordMessageForMinecraft(messageData, chatType);
            
            logger.discord(`[DC→MC] Processing ${chatType} message from Discord: ${messageData.author.displayName} -> "${messageData.content}"`);

            // Send message to all connected guilds
            let successCount = 0;
            let errorCount = 0;

            for (const guildInfo of connectedGuilds) {
                try {
                    // Send message based on chat type
                    await this.sendMessageToMinecraft(guildInfo.guildId, formattedMessage, chatType);
                    successCount++;
                    
                    logger.bridge(`[DC→MC] ✅ ${chatType} message sent to ${guildInfo.guildName}`);
                    
                } catch (error) {
                    errorCount++;
                    logger.logError(error, `Failed to send ${chatType} message to guild ${guildInfo.guildName}`);
                }
            }

            logger.discord(`[DC→MC] ✅ Discord message bridged to ${successCount}/${connectedGuilds.length} Minecraft guilds`);

        } catch (error) {
            logger.logError(error, `Error bridging Discord message to Minecraft`);
        }
    }

    /**
     * Determine chat type based on Discord channel type
     * @param {string} channelType - Discord channel type (chat/staff)
     * @returns {string|null} Minecraft chat type (guild/officer) or null
     */
    determineChatTypeFromChannel(channelType) {
        switch (channelType) {
            case 'chat':
                return 'guild';
            case 'staff':
                return 'officer';
            default:
                return null;
        }
    }

    /**
     * Format Discord message for Minecraft
     * @param {object} messageData - Discord message data
     * @param {string} chatType - Target chat type (guild/officer)
     * @returns {string} Formatted message
     */
    formatDiscordMessageForMinecraft(messageData, chatType) {
        const username = messageData.author.displayName || messageData.author.username;
        const content = messageData.content;
        
        // Add Discord prefix to distinguish from native Minecraft messages
        const prefix = "Discord >";
        
        // Format: Discord > Username: message content
        return `${prefix} ${username}: ${content}`;
    }

    /**
     * Send message to Minecraft guild
     * @param {string} guildId - Guild ID
     * @param {string} message - Formatted message
     * @param {string} chatType - Chat type (guild/officer)
     */
    async sendMessageToMinecraft(guildId, message, chatType) {
        try {
            // For officer chat, use /g o command, for guild chat use /g command
            const command = chatType === 'officer' ? `/oc ${message}` : `/gc ${message}`;
            
            // Use executeCommand instead of sendMessage for proper guild chat commands
            await this.minecraftManager.executeCommand(guildId, command);
            
        } catch (error) {
            logger.logError(error, `Failed to send ${chatType} message to guild ${guildId}`);
            throw error;
        }
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
     * Update routing configuration
     * @param {object} newConfig - New routing configuration
     */
    updateRoutingConfig(newConfig) {
        this.routingConfig = { ...this.routingConfig, ...newConfig };
        logger.bridge('BridgeCoordinator routing configuration updated');
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