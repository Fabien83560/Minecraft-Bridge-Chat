// Specific Imports
const BridgeLocator = require("../../../bridgeLocator.js");
const MessageFormatter = require("../../../shared/MessageFormatter.js");
const WebhookSender = require("../senders/WebhookSender.js");
const EmbedBuilder = require("../../utils/EmbedBuilder.js");
const logger = require("../../../shared/logger");

class MessageSender {
    constructor() {
        const mainBridge = BridgeLocator.getInstance();
        this.config = mainBridge.config;

        this.client = null;
        this.messageFormatter = null;
        this.webhookSender = null;
        this.embedBuilder = null;

        this.channels = {
            chat: null,
            staff: null
        };

        // Rate limiting
        this.rateLimiter = new Map(); // channelId -> last message times
        this.rateLimit = this.config.get('bridge.rateLimit.discord') || { limit: 5, window: 10000 };

        // Statistics
        this.stats = {
            messagesSent: 0,
            eventsSent: 0,
            systemMessagesSent: 0,
            rateLimitHits: 0,
            webhooksSent: 0,
            embedsSent: 0,
            errors: 0
        };

        this.initialize();
    }

    initialize() {
        try {
            // Initialize message formatter for Discord
            const formatterConfig = {
                showTags: this.config.get('bridge.interGuild.showTags') || false,
                showSourceTag: this.config.get('bridge.interGuild.showSourceTag') !== false,
                enableDebugLogging: this.config.get('features.messageSystem.enableDebugLogging') || false,
                maxMessageLength: 2000, // Discord limit
                fallbackToBasic: true
            };

            this.messageFormatter = new MessageFormatter(formatterConfig);

            // Initialize webhook sender if enabled
            const webhookConfig = this.config.get('bridge.webhook');
            if (webhookConfig && webhookConfig.enabled) {
                this.webhookSender = new WebhookSender();
            }

            // Initialize embed builder
            this.embedBuilder = new EmbedBuilder();

            logger.discord('MessageSender initialized');

        } catch (error) {
            logger.logError(error, 'Failed to initialize MessageSender');
            throw error;
        }
    }

    async initialize(client) {
        this.client = client;

        try {
            // Get and validate channels
            await this.validateAndCacheChannels();

            // Initialize webhook sender if enabled
            if (this.webhookSender) {
                await this.webhookSender.initialize(client);
            }

            logger.discord('MessageSender initialized with Discord client');

        } catch (error) {
            logger.logError(error, 'Failed to initialize MessageSender with client');
            throw error;
        }
    }

    async validateAndCacheChannels() {
        const bridgeConfig = this.config.get('bridge.channels');

        // Validate chat channel
        const chatChannel = await this.client.channels.fetch(bridgeConfig.chat.id);
        if (!chatChannel) {
            throw new Error(`Chat channel not found: ${bridgeConfig.chat.id}`);
        }
        this.channels.chat = chatChannel;

        // Validate staff channel
        const staffChannel = await this.client.channels.fetch(bridgeConfig.staff.id);
        if (!staffChannel) {
            throw new Error(`Staff channel not found: ${bridgeConfig.staff.id}`);
        }
        this.channels.staff = staffChannel;

        logger.discord(`Validated Discord channels - Chat: ${chatChannel.name}, Staff: ${staffChannel.name}`);
    }

    // ==================== MAIN SENDING METHODS ====================

    /**
     * Send guild chat message to Discord
     * @param {object} messageData - Parsed guild message data
     * @param {object} guildConfig - Guild configuration
     * @param {string} channelType - Channel type (chat/staff)
     * @returns {Promise} Send promise
     */
    async sendGuildMessage(messageData, guildConfig, channelType = 'chat') {
        try {
            // Check rate limiting
            const channel = this.channels[channelType];
            if (!channel) {
                throw new Error(`Channel not found: ${channelType}`);
            }

            if (this.isRateLimited(channel.id)) {
                this.stats.rateLimitHits++;
                logger.debug(`[DISCORD] Message rate limited for ${channelType} channel`);
                return null;
            }

            // Format message using templates
            const formattedMessage = this.messageFormatter.formatGuildMessage(
                messageData,
                guildConfig,
                guildConfig, // For Discord, source and target are same
                'messagesToDiscord'
            );

            if (!formattedMessage) {
                logger.warn(`[DISCORD] No formatted message generated for ${guildConfig.name}`);
                return null;
            }

            // Determine sending method (webhook vs normal)
            let result;
            if (this.shouldUseWebhook(messageData, guildConfig)) {
                result = await this.sendViaWebhook(formattedMessage, messageData, guildConfig, channelType);
                this.stats.webhooksSent++;
            } else {
                result = await this.sendViaChannel(formattedMessage, channel);
            }

            // Update rate limiting and stats
            this.updateRateLimit(channel.id);
            this.stats.messagesSent++;

            logger.bridge(`[DISCORD] Sent ${messageData.chatType || 'guild'} message to ${channelType} channel: "${formattedMessage.substring(0, 100)}${formattedMessage.length > 100 ? '...' : ''}"`);

            return result;

        } catch (error) {
            this.stats.errors++;
            logger.logError(error, `Failed to send guild message to Discord ${channelType} channel`);
            throw error;
        }
    }

    /**
     * Send guild event to Discord
     * @param {object} eventData - Parsed event data
     * @param {object} guildConfig - Guild configuration
     * @param {string} channelType - Channel type (chat/staff)
     * @returns {Promise} Send promise
     */
    async sendGuildEvent(eventData, guildConfig, channelType = 'chat') {
        try {
            const channel = this.channels[channelType];
            if (!channel) {
                throw new Error(`Channel not found: ${channelType}`);
            }

            if (this.isRateLimited(channel.id)) {
                this.stats.rateLimitHits++;
                logger.debug(`[DISCORD] Event rate limited for ${channelType} channel`);
                return null;
            }

            // Format event using templates
            const formattedMessage = this.messageFormatter.formatGuildEvent(
                eventData,
                guildConfig,
                guildConfig,
                'messagesToDiscord'
            );

            if (!formattedMessage) {
                logger.warn(`[DISCORD] No formatted event generated for ${guildConfig.name} - ${eventData.type}`);
                return null;
            }

            // Send via channel (events typically don't use webhooks)
            const result = await this.sendViaChannel(formattedMessage, channel);

            // Update rate limiting and stats
            this.updateRateLimit(channel.id);
            this.stats.eventsSent++;

            logger.bridge(`[DISCORD] Sent ${eventData.type} event to ${channelType} channel: "${formattedMessage}"`);

            return result;

        } catch (error) {
            this.stats.errors++;
            logger.logError(error, `Failed to send guild event to Discord ${channelType} channel`);
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
        try {
            const channel = this.channels[channelType];
            if (!channel) {
                throw new Error(`Channel not found: ${channelType}`);
            }

            // Format system message using templates
            const formattedMessage = this.messageFormatter.formatSystemMessage(
                type,
                data,
                guildConfig,
                'messagesToDiscord'
            );

            if (!formattedMessage) {
                logger.warn(`[DISCORD] No formatted system message generated for ${type}`);
                return null;
            }

            // Send via channel
            const result = await this.sendViaChannel(formattedMessage, channel);

            this.stats.systemMessagesSent++;

            logger.bridge(`[DISCORD] Sent system message to ${channelType} channel: "${formattedMessage}"`);

            return result;

        } catch (error) {
            this.stats.errors++;
            logger.logError(error, `Failed to send system message to Discord ${channelType} channel`);
            throw error;
        }
    }

    /**
     * Send connection status to Discord
     * @param {string} status - Connection status
     * @param {object} guildConfig - Guild configuration
     * @param {object} details - Additional details
     * @returns {Promise} Send promise
     */
    async sendConnectionStatus(status, guildConfig, details = {}) {
        try {
            const channel = this.channels.chat; // Connection status goes to chat channel

            let message;
            let embed = null;

            switch (status) {
                case 'connected':
                    message = `✅ **${guildConfig.name}** bot connected to Hypixel`;
                    embed = this.embedBuilder.createConnectionEmbed(guildConfig, status, details);
                    break;
                    
                case 'disconnected':
                    const reason = details.reason ? ` (${details.reason})` : '';
                    message = `🔴 **${guildConfig.name}** bot disconnected${reason}`;
                    embed = this.embedBuilder.createConnectionEmbed(guildConfig, status, details);
                    break;
                    
                case 'reconnected':
                    message = `🔄 **${guildConfig.name}** bot reconnected`;
                    embed = this.embedBuilder.createConnectionEmbed(guildConfig, status, details);
                    break;
                    
                default:
                    message = `🔧 **${guildConfig.name}** status: ${status}`;
                    break;
            }

            // Send with or without embed
            let result;
            if (embed) {
                result = await channel.send({ content: message, embeds: [embed] });
                this.stats.embedsSent++;
            } else {
                result = await channel.send(message);
            }

            logger.bridge(`[DISCORD] Sent connection status for ${guildConfig.name}: ${status}`);

            return result;

        } catch (error) {
            this.stats.errors++;
            logger.logError(error, `Failed to send connection status to Discord`);
            throw error;
        }
    }

    // ==================== SENDING IMPLEMENTATION METHODS ====================

    /**
     * Send message via webhook
     * @param {string} message - Formatted message
     * @param {object} messageData - Original message data
     * @param {object} guildConfig - Guild configuration
     * @param {string} channelType - Channel type
     * @returns {Promise} Send promise
     */
    async sendViaWebhook(message, messageData, guildConfig, channelType) {
        if (!this.webhookSender) {
            throw new Error('Webhook sender not initialized');
        }

        return await this.webhookSender.sendMessage(message, messageData, guildConfig, channelType);
    }

    /**
     * Send message via regular channel
     * @param {string} message - Formatted message
     * @param {object} channel - Discord channel
     * @returns {Promise} Send promise
     */
    async sendViaChannel(message, channel) {
        // Split message if too long for Discord
        if (message.length > 2000) {
            const chunks = this.splitMessage(message, 2000);
            const results = [];
            
            for (const chunk of chunks) {
                const result = await channel.send(chunk);
                results.push(result);
            }
            
            return results;
        }

        return await channel.send(message);
    }

    /**
     * Split long message into chunks
     * @param {string} message - Message to split
     * @param {number} maxLength - Maximum chunk length
     * @returns {Array} Message chunks
     */
    splitMessage(message, maxLength = 2000) {
        if (message.length <= maxLength) {
            return [message];
        }

        const chunks = [];
        let currentChunk = '';

        const lines = message.split('\n');
        
        for (const line of lines) {
            if ((currentChunk + line + '\n').length > maxLength) {
                if (currentChunk) {
                    chunks.push(currentChunk.trim());
                    currentChunk = '';
                }
                
                // If single line is too long, split by words
                if (line.length > maxLength) {
                    const words = line.split(' ');
                    for (const word of words) {
                        if ((currentChunk + word + ' ').length > maxLength) {
                            if (currentChunk) {
                                chunks.push(currentChunk.trim());
                                currentChunk = '';
                            }
                        }
                        currentChunk += word + ' ';
                    }
                } else {
                    currentChunk = line + '\n';
                }
            } else {
                currentChunk += line + '\n';
            }
        }

        if (currentChunk.trim()) {
            chunks.push(currentChunk.trim());
        }

        return chunks;
    }

    // ==================== UTILITY METHODS ====================

    /**
     * Check if should use webhook for message
     * @param {object} messageData - Message data
     * @param {object} guildConfig - Guild configuration
     * @returns {boolean} Whether to use webhook
     */
    shouldUseWebhook(messageData, guildConfig) {
        const webhookConfig = this.config.get('bridge.webhook');
        
        if (!webhookConfig || !webhookConfig.enabled || !this.webhookSender) {
            return false;
        }

        // Use webhook for guild chat messages (not officer or events)
        return messageData.chatType === 'guild' || (!messageData.chatType && messageData.type === 'guild_chat');
    }

    /**
     * Check if channel is rate limited
     * @param {string} channelId - Channel ID
     * @returns {boolean} Whether channel is rate limited
     */
    isRateLimited(channelId) {
        if (!this.rateLimit || this.rateLimit.limit <= 0) {
            return false;
        }

        const now = Date.now();
        const channelTimes = this.rateLimiter.get(channelId) || [];

        // Remove old timestamps
        const validTimes = channelTimes.filter(time => now - time < this.rateLimit.window);

        return validTimes.length >= this.rateLimit.limit;
    }

    /**
     * Update rate limiting for channel
     * @param {string} channelId - Channel ID
     */
    updateRateLimit(channelId) {
        if (!this.rateLimit || this.rateLimit.limit <= 0) {
            return;
        }

        const now = Date.now();
        const channelTimes = this.rateLimiter.get(channelId) || [];

        // Add current time
        channelTimes.push(now);

        // Remove old timestamps
        const validTimes = channelTimes.filter(time => now - time < this.rateLimit.window);

        this.rateLimiter.set(channelId, validTimes);
    }

    /**
     * Get channel by type
     * @param {string} channelType - Channel type (chat/staff)
     * @returns {Channel|null} Discord channel
     */
    getChannel(channelType) {
        return this.channels[channelType] || null;
    }

    /**
     * Get statistics
     * @returns {object} Sender statistics
     */
    getStatistics() {
        return {
            ...this.stats,
            rateLimiterSize: this.rateLimiter.size,
            channels: {
                chat: this.channels.chat ? {
                    id: this.channels.chat.id,
                    name: this.channels.chat.name
                } : null,
                staff: this.channels.staff ? {
                    id: this.channels.staff.id,
                    name: this.channels.staff.name
                } : null
            },
            webhookEnabled: !!this.webhookSender
        };
    }

    /**
     * Clear rate limiter
     */
    clearRateLimit() {
        this.rateLimiter.clear();
        logger.debug('Discord MessageSender rate limiter cleared');
    }

    /**
     * Update configuration
     * @param {object} newConfig - New configuration
     */
    updateConfig(newConfig) {
        // Update message formatter config
        if (this.messageFormatter) {
            const formatterConfig = {
                showTags: newConfig.showTags !== undefined ? newConfig.showTags : this.config.get('bridge.interGuild.showTags'),
                showSourceTag: newConfig.showSourceTag !== undefined ? newConfig.showSourceTag : this.config.get('bridge.interGuild.showSourceTag')
            };
            
            this.messageFormatter.updateConfig(formatterConfig);
        }

        logger.debug('Discord MessageSender configuration updated');
    }

    /**
     * Cleanup resources
     */
    cleanup() {
        this.rateLimiter.clear();
        
        if (this.webhookSender) {
            this.webhookSender.cleanup();
        }

        logger.debug('Discord MessageSender cleaned up');
    }
}

module.exports = MessageSender;