// Globals Imports
const EventEmitter = require('events');

// Specific Imports
const BridgeLocator = require("../../../bridgeLocator.js");
const { getPatternLoader } = require("../../../config/PatternLoader.js");
const logger = require("../../../shared/logger");

class CommandResponseListener extends EventEmitter {
    constructor() {
        super();
        
        this.activeListeners = new Map();
        this.listenerCounter = 0;
        
        // Response patterns for different command types
        this.responsePatterns = {};
        
        // Load patterns from configuration
        this.loadResponsePatterns();

        logger.debug('CommandResponseListener initialized');
    }

    /**
     * Load response patterns from configuration
     */
    loadResponsePatterns() {
        try {
            // Initialize with empty object first
            this.responsePatterns = {};
            
            const patternLoader = getPatternLoader();
            const commandsResponseConfig = patternLoader.getCommandsResponsePatterns('Hypixel');
            
            if (!commandsResponseConfig) {
                logger.warn('No commands response patterns found for Hypixel');
                return;
            }

            // Convert JSON patterns to RegExp objects
            for (const [commandType, patterns] of Object.entries(commandsResponseConfig)) {
                this.responsePatterns[commandType] = {
                    success: [],
                    error: []
                };

                // Convert success patterns
                if (patterns.success) {
                    for (const patternConfig of patterns.success) {
                        try {
                            // Use flags from pattern config, default to 'i' for case insensitive
                            const regex = new RegExp(patternConfig.pattern, 'i');
                            this.responsePatterns[commandType].success.push({
                                pattern: regex,
                                groups: patternConfig.groups || [],
                                description: patternConfig.description || 'No description'
                            });
                        } catch (error) {
                            logger.logError(error, `Failed to compile success pattern for ${commandType}: ${patternConfig.pattern}`);
                        }
                    }
                }

                // Convert error patterns
                if (patterns.error) {
                    for (const patternConfig of patterns.error) {
                        try {
                            // Use flags from pattern config, default to 'i' for case insensitive
                            const regex = new RegExp(patternConfig.pattern, 'i');
                            this.responsePatterns[commandType].error.push({
                                pattern: regex,
                                groups: patternConfig.groups || [],
                                description: patternConfig.description || 'No description'
                            });
                        } catch (error) {
                            logger.logError(error, `Failed to compile error pattern for ${commandType}: ${patternConfig.pattern}`);
                        }
                    }
                }
            }

            logger.debug(`Loaded command response patterns for: ${Object.keys(this.responsePatterns).join(', ')}`);

        } catch (error) {
            logger.logError(error, 'Failed to load command response patterns');
        }
    }

    /**
     * Create a new command listener
     * @param {string} guildId - Guild ID to listen to
     * @param {string} commandType - Type of command (invite, kick, etc.)
     * @param {string} targetPlayer - Player being targeted by the command
     * @param {number} timeoutMs - Timeout in milliseconds (default: 10000)
     * @param {object} interaction - Discord interaction object (optional)
     * @returns {string} Listener ID
     */
    createListener(guildId, commandType, targetPlayer, command, timeoutMs = 10000, interaction = null) {
        const listenerId = `cmd_${++this.listenerCounter}_${Date.now()}`;
        
        const listener = {
            id: listenerId,
            guildId: guildId,
            command: command,
            commandType: commandType.toLowerCase(),
            targetPlayer: targetPlayer.toLowerCase(),
            createdAt: Date.now(),
            timeout: null,
            resolved: false,
            messageHandler: null,
            eventHandler: null,
            rawMessageHandler: null,
            interaction: interaction
        };

        // Set up timeout
        listener.timeout = setTimeout(() => {
            this.resolveListener(listenerId, {
                success: false,
                error: 'Command timeout - no response received',
                type: 'timeout'
            });
        }, timeoutMs);

        // Set up message handler
        listener.messageHandler = (messageData) => {
            this.handleMessage(listenerId, messageData);
        };

        // Set up event handler
        listener.eventHandler = (eventData) => {
            this.handleEvent(listenerId, eventData);
        };

        // Store listener
        this.activeListeners.set(listenerId, listener);

        // Attach to Minecraft message system
        this.attachToMinecraftMessages(listener);

        logger.debug(`Created command listener ${listenerId} for ${commandType} on ${guildId} targeting ${targetPlayer}`);

        return listenerId;
    }

    /**
     * Attach listener to Minecraft message system
     * @param {object} listener - Listener configuration
     */
    attachToMinecraftMessages(listener) {
        try {
            const mainBridge = BridgeLocator.getInstance();
            const minecraftManager = mainBridge.getMinecraftManager?.();
            
            if (!minecraftManager) {
                throw new Error('MinecraftManager not available');
            }

            // Listen to ALL raw messages from the specific bot connection
            const botManager = minecraftManager._botManager;
            if (!botManager) {
                throw new Error('BotManager not available');
            }

            // Get the specific connection for this guild
            const connection = botManager.connections.get(listener.guildId);
            if (!connection) {
                throw new Error(`No connection found for guild: ${listener.guildId}`);
            }

            // Listen to raw messages directly from the bot connection
            listener.rawMessageHandler = (message) => {
                this.handleRawMessage(listener.id, message, listener.guildId);
            };

            // Attach to the bot's message event
            const bot = connection._bot;
            if (bot) {
                bot.on('message', listener.rawMessageHandler);
                logger.debug(`Attached listener ${listener.id} to raw messages from bot`);
            }

            // Also listen to events (for kick, promote, demote events)  
            minecraftManager.onEvent(listener.eventHandler);

            logger.debug(`Attached listener ${listener.id} to Minecraft raw message and event systems`);

        } catch (error) {
            logger.logError(error, `Failed to attach listener ${listener.id} to Minecraft messages`);
            this.resolveListener(listener.id, {
                success: false,
                error: 'Failed to attach message listener',
                type: 'system_error'
            });
        }
    }

    /**
     * Handle incoming raw Minecraft message (bypasses guild message filtering)
     * @param {string} listenerId - Listener ID
     * @param {object} message - Raw message from Minecraft bot
     * @param {string} guildId - Guild ID for context
     */
    handleRawMessage(listenerId, message, guildId) {
        const listener = this.activeListeners.get(listenerId);
        
        if (!listener || listener.resolved) {
            return;
        }

        // Convert message to string and clean it
        const messageText = message.toString ? message.toString() : String(message);
        const cleanMessage = messageText.replace(/§[0-9a-fklmnor]/g, '').trim();
        
        logger.debug(`[${listenerId}] Processing raw message: "${cleanMessage}"`);
        
        // Ensure patterns exist for this command type
        if (!this.responsePatterns || !this.responsePatterns[listener.commandType]) {
            logger.warn(`No response patterns found for command type: ${listener.commandType}`);
            return;
        }
        
        const patterns = this.responsePatterns[listener.commandType];

        // Check for success patterns
        if (patterns.success && Array.isArray(patterns.success)) {
            for (let i = 0; i < patterns.success.length; i++) {
                const patternObj = patterns.success[i];
                const match = cleanMessage.match(patternObj.pattern);
                
                if (match) {
                    logger.debug(`[${listenerId}] Success pattern ${i} matched: ${patternObj.description}`);
                    logger.debug(`[${listenerId}] Match groups:`, match.slice(1));
                    
                    // Apply command-specific validation
                    let isValidMatch = false;
                    
                    if (listener.commandType === 'mute' || listener.commandType === 'unmute') {
                        if (listener.targetPlayer === 'everyone') {
                            // For global commands, check if it's a guild-wide pattern
                            isValidMatch = cleanMessage.includes('guild chat');
                            logger.debug(`[${listenerId}] Global command - guild chat check: ${isValidMatch}`);
                        } else {
                            // For player-specific commands, check if target matches
                            const extractedTarget = match[2] ? match[2].toLowerCase() : null;
                            isValidMatch = extractedTarget && extractedTarget === listener.targetPlayer.toLowerCase();
                            logger.debug(`[${listenerId}] Player command - target "${extractedTarget}" vs "${listener.targetPlayer}": ${isValidMatch}`);
                        }
                    } else {
                        // For other command types, use original logic
                        const extractedPlayer = match[1] ? match[1].toLowerCase() : null;
                        isValidMatch = !extractedPlayer || extractedPlayer === listener.targetPlayer.toLowerCase();
                        logger.debug(`[${listenerId}] Other command - player match: ${isValidMatch}`);
                    }
                    
                    if (isValidMatch) {
                        logger.debug(`[${listenerId}] ✅ Success pattern validated! Resolving listener.`);
                        this.resolveListener(listenerId, {
                            success: true,
                            message: cleanMessage,
                            type: 'success',
                            extractedData: {
                                fullMatch: match[0],
                                groups: match.slice(1),
                                patternDescription: patternObj.description
                            }
                        });
                        return;
                    } else {
                        logger.debug(`[${listenerId}] Pattern matched but validation failed - continuing to next pattern`);
                    }
                } else {
                    logger.debug(`[${listenerId}] Success pattern ${i} did not match`);
                }
            }
        }

        // Check for error patterns
        if (patterns.error && Array.isArray(patterns.error)) {
            for (let i = 0; i < patterns.error.length; i++) {
                const patternObj = patterns.error[i];
                const match = cleanMessage.match(patternObj.pattern);
                
                if (match) {
                    logger.debug(`[${listenerId}] ❌ Error pattern ${i} matched: ${patternObj.description}`);
                    this.resolveListener(listenerId, {
                        success: false,
                        error: cleanMessage,
                        type: 'command_error',
                        extractedData: {
                            fullMatch: match[0],
                            groups: match.slice(1),
                            patternDescription: patternObj.description
                        }
                    });
                    return;
                }
            }
        }
        
        logger.debug(`[${listenerId}] No patterns matched for message: "${cleanMessage}"`);
    }

    /**
     * Handle incoming Minecraft message
     * @param {string} listenerId - Listener ID
     * @param {object} messageData - Message data from Minecraft
     */
    handleMessage(listenerId, messageData) {
        // Just delegate to handleRawMessage for consistency
        const message = messageData.message || messageData.toString();
        this.handleRawMessage(listenerId, message, messageData.guildId);
    }

    /**
     * Handle incoming Minecraft event
     * @param {string} listenerId - Listener ID
     * @param {object} eventData - Event data from Minecraft
     */
    handleEvent(listenerId, eventData) {
        const listener = this.activeListeners.get(listenerId);
        
        if (!listener || listener.resolved) {
            return;
        }

        // Only process events from the correct guild
        if (eventData.guildId !== listener.guildId) {
            return;
        }

        // Only process relevant event types
        if (eventData.type !== listener.commandType) {
            return;
        }

        // Check if the target player matches
        const eventPlayer = eventData.username ? eventData.username.toLowerCase() : null;
        if (!eventPlayer || eventPlayer !== listener.targetPlayer) {
            return;
        }

        logger.debug(`Event detected for listener ${listenerId}: ${eventData.type} - ${eventData.username}`);

        // For kick events, this is a success
        if (eventData.type === 'kick' && listener.commandType === 'kick') {
            this.resolveListener(listenerId, {
                success: true,
                message: `${eventData.username} was kicked from the guild`,
                type: 'success',
                extractedData: {
                    player: eventData.username,
                    event: eventData
                }
            });
            return;
        }

        // For invite events, this could be either success (join) or failure
        if (eventData.type === 'join' && listener.commandType === 'invite') {
            this.resolveListener(listenerId, {
                success: true,
                message: `${eventData.username} joined the guild`,
                type: 'success',
                extractedData: {
                    player: eventData.username,
                    event: eventData
                }
            });
            return;
        }

        // For promote/demote events
        if ((eventData.type === 'promote' && listener.commandType === 'promote') ||
            (eventData.type === 'demote' && listener.commandType === 'demote')) {
            this.resolveListener(listenerId, {
                success: true,
                message: `${eventData.username} was ${eventData.type}d`,
                type: 'success',
                extractedData: {
                    player: eventData.username,
                    event: eventData
                }
            });
            return;
        }
    }

    /**
     * Resolve a listener with a result
     * @param {string} listenerId - Listener ID
     * @param {object} result - Result object
     */
    resolveListener(listenerId, result) {
        const listener = this.activeListeners.get(listenerId);
        
        if (!listener || listener.resolved) {
            return;
        }

        listener.resolved = true;

        // Clear timeout
        if (listener.timeout) {
            clearTimeout(listener.timeout);
        }

        // Send command log to Discord if successful
        if (result.success) {
            this.sendCommandLog(listener, result);
        }

        // Remove message handlers
        try {
            const mainBridge = BridgeLocator.getInstance();
            const minecraftManager = mainBridge.getMinecraftManager?.();
            
            if (minecraftManager) {
                // Remove raw message handler from bot
                if (listener.rawMessageHandler) {
                    try {
                        const botManager = minecraftManager._botManager;
                        const connection = botManager?.connections?.get(listener.guildId);
                        const bot = connection?._bot;
                        
                        if (bot) {
                            bot.removeListener('message', listener.rawMessageHandler);
                            logger.debug(`Removed raw message handler for listener ${listenerId}`);
                        }
                    } catch (error) {
                        logger.logError(error, `Failed to remove raw message handler for listener ${listenerId}`);
                    }
                }
                
                logger.debug(`Detached listener ${listenerId} from message and event systems`);
            }
        } catch (error) {
            logger.logError(error, `Failed to detach listener ${listenerId}`);
        }

        // Remove from active listeners
        this.activeListeners.delete(listenerId);

        // Emit result
        this.emit('commandResult', {
            listenerId: listenerId,
            guildId: listener.guildId,
            commandType: listener.commandType,
            targetPlayer: listener.targetPlayer,
            result: result,
            duration: Date.now() - listener.createdAt
        });

        logger.debug(`Resolved listener ${listenerId} with result: ${JSON.stringify(result)}`);
    }

    /**
     * Send command log to Discord channel
     * @param {object} listener - Listener configuration
     * @param {object} result - Command result
     */
    async sendCommandLog(listener, result) {
        try {
            const mainBridge = BridgeLocator.getInstance();
            const discordManager = mainBridge.getDiscordManager?.();
            
            if (!discordManager || !discordManager.isConnected()) {
                logger.debug('Discord manager not available for command logging');
                return;
            }

            // Get Discord bot client
            const client = discordManager._discordBot?.getClient();
            if (!client) {
                logger.debug('Discord client not available for command logging');
                return;
            }

            // Get log channels configuration
            const config = mainBridge.config;
            const logChannels = config.get('discord.logChannels');
            if (!logChannels) {
                logger.debug('No log channels configured');
                return;
            }

            // Determine which channel to use
            const commandChannelId = logChannels[listener.commandType];
            const channelId = commandChannelId && commandChannelId.trim() !== '' 
                ? commandChannelId 
                : logChannels.default;

            if (!channelId || channelId.trim() === '') {
                logger.debug(`No log channel configured for command type: ${listener.commandType}`);
                return;
            }

            // Get the channel
            const channel = await client.channels.fetch(channelId).catch(() => null);
            if (!channel) {
                logger.warn(`Could not find Discord log channel: ${channelId}`);
                return;
            }

            // Get guild name for the log
            const guilds = config.get('guilds') || [];
            const guildConfig = guilds.find(g => g.id === listener.guildId);
            const guildName = guildConfig ? guildConfig.name : listener.guildId;

            // Create embed for the log
            const { EmbedBuilder } = require('discord.js');
            const embed = new EmbedBuilder()
                .setTitle(`${this.capitalizeFirst(listener.commandType)} Command Executed`)
                .setColor(0x00FF00) // Green for success
                .addFields(
                    { name: 'Guild', value: guildName, inline: true },
                    { name: 'Target Player', value: listener.targetPlayer, inline: true },
                    { name: 'Command Type', value: listener.commandType.toUpperCase(), inline: true },
                    { name: 'Command', value: `\`${listener.command}\``, inline: true },
                    { name: 'Duration', value: `${result.duration || (Date.now() - listener.createdAt)}ms`, inline: true },
                    { name: 'Response', value: result.message || 'Command completed successfully', inline: false }
                )
                .setTimestamp()
                .setFooter({ text: 'Guild Command System' });

            // Add message link if interaction is available
            if (listener.interaction) {
                try {
                    // Create Discord message link
                    const guildId = listener.interaction.guildId || listener.interaction.guild?.id;
                    const channelId = listener.interaction.channelId || listener.interaction.channel?.id;
                    const messageId = listener.interaction.id; // For slash commands, use interaction ID
                    
                    if (guildId && channelId) {
                        // Try to get the actual message ID from the interaction
                        let actualMessageId = messageId;
                        
                        // For slash commands, we need to get the reply message ID
                        if (listener.interaction.replied) {
                            try {
                                const reply = await listener.interaction.fetchReply();
                                if (reply && reply.id) {
                                    actualMessageId = reply.id;
                                }
                            } catch (error) {
                                // If we can't fetch the reply, use interaction ID as fallback
                                logger.debug('Could not fetch interaction reply, using interaction ID');
                            }
                        }
                        
                        const messageLink = `https://discord.com/channels/${guildId}/${channelId}/${actualMessageId}`;
                        
                        embed.addFields({ 
                            name: 'Original Command', 
                            value: `[View Message](${messageLink})`, 
                            inline: true 
                        });
                        
                        // Also add executor information
                        const executor = listener.interaction.user;
                        if (executor) {
                            embed.addFields({ 
                                name: 'Executed By', 
                                value: `${executor.displayName || executor.username} (${executor.id})`, 
                                inline: true 
                            });
                        }
                    }
                } catch (error) {
                    logger.debug('Could not create message link for command log', error);
                }
            }

            // Send the log message
            await channel.send({ embeds: [embed] });
            
            logger.debug(`Command log sent to Discord channel ${channelId} for ${listener.commandType} command`);

        } catch (error) {
            logger.logError(error, 'Failed to send command log to Discord');
        }
    }

    /**
     * Capitalize first letter of a string
     * @param {string} str - String to capitalize
     * @returns {string} Capitalized string
     */
    capitalizeFirst(str) {
        if (!str) return '';
        return str.charAt(0).toUpperCase() + str.slice(1);
    }

    /**
     * Cancel a listener
     * @param {string} listenerId - Listener ID
     */
    cancelListener(listenerId) {
        const listener = this.activeListeners.get(listenerId);
        
        if (!listener) {
            return false;
        }

        this.resolveListener(listenerId, {
            success: false,
            error: 'Command cancelled by user',
            type: 'cancelled'
        });

        return true;
    }

    /**
     * Wait for a command result
     * @param {string} listenerId - Listener ID
     * @returns {Promise<object>} Command result
     */
    waitForResult(listenerId) {
        return new Promise((resolve) => {
            const handleResult = (data) => {
                if (data.listenerId === listenerId) {
                    this.removeListener('commandResult', handleResult);
                    resolve(data.result);
                }
            };

            this.on('commandResult', handleResult);

            // Check if already resolved
            if (!this.activeListeners.has(listenerId)) {
                this.removeListener('commandResult', handleResult);
                resolve({
                    success: false,
                    error: 'Listener not found or already resolved',
                    type: 'not_found'
                });
            }
        });
    }

    /**
     * Get active listeners count
     * @returns {number} Number of active listeners
     */
    getActiveListenersCount() {
        return this.activeListeners.size;
    }

    /**
     * Get statistics
     * @returns {object} Statistics
     */
    getStatistics() {
        const listeners = Array.from(this.activeListeners.values());
        
        return {
            activeListeners: listeners.length,
            listenersByGuild: listeners.reduce((acc, listener) => {
                acc[listener.guildId] = (acc[listener.guildId] || 0) + 1;
                return acc;
            }, {}),
            listenersByType: listeners.reduce((acc, listener) => {
                acc[listener.commandType] = (acc[listener.commandType] || 0) + 1;
                return acc;
            }, {}),
            totalCreated: this.listenerCounter
        };
    }

    /**
     * Cleanup all listeners
     */
    cleanup() {
        for (const [listenerId] of this.activeListeners) {
            this.cancelListener(listenerId);
        }
        
        this.removeAllListeners();
        logger.debug('CommandResponseListener cleaned up');
    }
}

module.exports = CommandResponseListener;