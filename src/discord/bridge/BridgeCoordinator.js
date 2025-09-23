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

    // ==================== ERROR HANDLING UTILITIES ====================

    /**
     * Add error reaction to Discord message
     * @param {object} messageData - Original Discord message data
     */
    async addErrorReaction(messageData) {
        try {
            if (!messageData.messageRef) {
                logger.warn('Cannot add error reaction - message reference not available');
                return;
            }

            const message = messageData.messageRef;
            await message.react('❌');
            
            logger.debug(`Added error reaction to message from ${messageData.author.username}`);
        } catch (error) {
            logger.logError(error, 'Failed to add error reaction to Discord message');
        }
    }

    /**
     * Add success reaction to Discord message
     * @param {object} messageData - Original Discord message data
     */
    async addSuccessReaction(messageData) {
        try {
            if (!messageData.messageRef) {
                logger.warn('Cannot add success reaction - message reference not available');
                return;
            }

            const message = messageData.messageRef;
            await message.react('✅');
            
            logger.debug(`Added success reaction to message from ${messageData.author.username}`);
        } catch (error) {
            logger.logError(error, 'Failed to add success reaction to Discord message');
        }
    }

    /**
     * Send ephemeral error message to user
     * @param {object} messageData - Original Discord message data
     * @param {string} errorMessage - Error message to send
     * @param {number} successCount - Number of successful deliveries
     * @param {number} totalCount - Total number of attempted deliveries
     */
    async sendEphemeralErrorMessage(messageData, errorMessage, successCount = 0, totalCount = 0) {
        try {
            // Try to send a direct message to the user
            if (messageData.author) {
                try {
                    const embed = {
                        color: 0xFF0000, // Red color
                        title: '❌ Message Delivery Error',
                        description: 'Your message could not be delivered to all Minecraft guilds.',
                        fields: [
                            {
                                name: 'Delivery Status',
                                value: totalCount > 0 
                                    ? `${successCount}/${totalCount} guilds received the message`
                                    : 'No guilds were available to receive the message',
                                inline: false
                            },
                            {
                                name: 'Error Details',
                                value: `\`\`\`${errorMessage.length > 800 ? errorMessage.substring(0, 797) + '...' : errorMessage}\`\`\``,
                                inline: false
                            },
                            {
                                name: 'Original Message',
                                value: messageData.content.length > 100 
                                    ? `${messageData.content.substring(0, 97)}...`
                                    : messageData.content,
                                inline: false
                            }
                        ],
                        timestamp: new Date().toISOString(),
                        footer: {
                            text: 'Discord to Minecraft Bridge Error'
                        }
                    };

                    await messageData.author.send({ embeds: [embed] });
                    logger.debug(`Sent error DM to ${messageData.author.username}`);
                    return;

                } catch (dmError) {
                    logger.warn(`Could not send DM to ${messageData.author.username}, user may have DMs disabled`);
                }
            }

            // Fallback: try to send a message in the same channel that mentions the user
            if (messageData.channel && messageData.channel.send) {
                try {
                    const errorMsg = await messageData.channel.send({
                        content: `<@${messageData.author.id}> ❌ Your message could not be delivered to some Minecraft guilds. Check your DMs for details (or enable DMs if they're disabled).`,
                        allowedMentions: { users: [messageData.author.id] }
                    });

                    // Delete the error message after 10 seconds to keep channel clean
                    setTimeout(async () => {
                        try {
                            await errorMsg.delete();
                        } catch (deleteError) {
                            logger.debug('Could not delete temporary error message');
                        }
                    }, 10000);

                } catch (channelError) {
                    logger.logError(channelError, 'Failed to send fallback error message in channel');
                }
            }

        } catch (error) {
            logger.logError(error, 'Failed to send ephemeral error message');
        }
    }

    /**
     * Handle errors during message bridging
     * @param {object} messageData - Original Discord message data
     * @param {Error} error - The error that occurred
     * @param {number} successCount - Number of successful deliveries
     * @param {number} totalCount - Total number of attempted deliveries
     */
    async handleBridgeError(messageData, error, successCount = 0, totalCount = 0) {
        try {
            // Add error reaction to original message
            await this.addErrorReaction(messageData);

            // Prepare error message
            let errorMessage = '';
            
            if (totalCount > 0) {
                errorMessage = `Message delivery failed for ${totalCount - successCount}/${totalCount} Minecraft guilds.`;
                if (successCount > 0) {
                    errorMessage += `\nSuccessfully delivered to ${successCount} guilds.`;
                }
            } else {
                errorMessage = 'No Minecraft guilds were available to receive the message.';
            }
            
            errorMessage += `\n\nError: ${error.message}`;

            // Send ephemeral error message to user
            await this.sendEphemeralErrorMessage(messageData, errorMessage, successCount, totalCount);

            logger.warn(`Bridge error handled for user ${messageData.author.username}: ${error.message}`);

        } catch (handleError) {
            logger.logError(handleError, 'Failed to handle bridge error properly');
        }
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

    // ==================== DISCORD TO MINECRAFT HANDLERS ====================

    /**
     * Enhanced Discord message handler with error handling
     * @param {object} messageData - Discord message data
     */
    async handleDiscordMessage(messageData) {
        let successCount = 0;
        let errorCount = 0;
        let connectedGuilds = [];

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
                const error = new Error('Minecraft manager not ready');
                await this.handleBridgeError(messageData, error, 0, 0);
                return;
            }

            // Determine target chat type based on Discord channel
            const chatType = this.determineChatTypeFromChannel(messageData.channelType);
            if (!chatType) {
                logger.debug(`[DC→MC] Unknown channel type: ${messageData.channelType}, skipping message`);
                return;
            }

            // Get connected Minecraft guilds
            connectedGuilds = this.minecraftManager.getConnectedGuilds();
            if (!connectedGuilds || connectedGuilds.length === 0) {
                const error = new Error('No connected Minecraft guilds available');
                await this.handleBridgeError(messageData, error, 0, 0);
                return;
            }

            // Format message for Minecraft
            const formattedMessage = this.formatDiscordMessageForMinecraft(messageData, chatType);
            
            logger.discord(`[DC→MC] Processing ${chatType} message from Discord: ${messageData.author.displayName} -> "${messageData.content}"`);

            // Send message to all connected guilds with error tracking
            const deliveryPromises = connectedGuilds.map(async (guildInfo) => {
                try {
                    await this.sendMessageToMinecraft(guildInfo.guildId, formattedMessage, chatType);
                    logger.bridge(`[DC→MC] ✅ ${chatType} message sent to ${guildInfo.guildName}`);
                    return { success: true, guildInfo };
                } catch (error) {
                    logger.logError(error, `Failed to send ${chatType} message to guild ${guildInfo.guildName}`);
                    return { success: false, guildInfo, error };
                }
            });

            // Wait for all deliveries to complete
            const results = await Promise.allSettled(deliveryPromises);
            
            // Count actual successes and failures
            successCount = 0;
            errorCount = 0;
            let firstError = null;

            results.forEach(result => {
                if (result.status === 'fulfilled') {
                    if (result.value.success) {
                        successCount++;
                    } else {
                        errorCount++;
                        if (!firstError) {
                            firstError = result.value.error || new Error('Unknown delivery error');
                        }
                    }
                } else {
                    errorCount++;
                    if (!firstError) {
                        firstError = result.reason || new Error('Unknown delivery error');
                    }
                }
            });

            if (errorCount > 0) {
                // Some deliveries failed
                await this.handleBridgeError(messageData, firstError, successCount, connectedGuilds.length);
            } else {
                // All deliveries successful - no success reaction, just log
                logger.discord(`[DC→MC] ✅ Discord message bridged successfully to all ${connectedGuilds.length} Minecraft guilds`);
            }

        } catch (error) {
            logger.logError(error, `Unexpected error bridging Discord message to Minecraft`);
            await this.handleBridgeError(messageData, error, successCount, connectedGuilds.length);
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
            // For officer chat, use /oc command, for guild chat use /gc command
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