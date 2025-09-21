// Globals Imports
const { EmbedBuilder: DiscordEmbedBuilder } = require('discord.js');

// Specific Imports
const BridgeLocator = require("../../../bridgeLocator.js");
const MessageFormatter = require("../../../shared/MessageFormatter.js");
const WebhookSender = require("./WebhookSender.js");
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

        // Initialize only the components that don't require Discord client
        this.initializeComponents();
    }

    /**
     * Initialize components that don't require Discord client
     * This is called in constructor
     */
    initializeComponents() {
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

            logger.discord('MessageSender components initialized');

        } catch (error) {
            logger.logError(error, 'Failed to initialize MessageSender components');
            throw error;
        }
    }

    /**
     * Initialize with Discord client
     * This is called after Discord client is ready
     * @param {Client} client - Discord client instance
     */
    async initialize(client) {
        if (!client) {
            throw new Error('Discord client is required for MessageSender initialization');
        }

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
        if (!this.client) {
            throw new Error('Discord client not available for channel validation');
        }

        const bridgeConfig = this.config.get('bridge.channels');

        if (!bridgeConfig) {
            throw new Error('Bridge channels configuration not found');
        }

        try {
            // Validate chat channel
            if (!bridgeConfig.chat || !bridgeConfig.chat.id) {
                throw new Error('Chat channel ID not configured');
            }

            const chatChannel = await this.client.channels.fetch(bridgeConfig.chat.id);
            if (!chatChannel) {
                throw new Error(`Chat channel not found: ${bridgeConfig.chat.id}`);
            }
            this.channels.chat = chatChannel;

            // Validate staff channel
            if (!bridgeConfig.staff || !bridgeConfig.staff.id) {
                throw new Error('Staff channel ID not configured');
            }

            const staffChannel = await this.client.channels.fetch(bridgeConfig.staff.id);
            if (!staffChannel) {
                throw new Error(`Staff channel not found: ${bridgeConfig.staff.id}`);
            }
            this.channels.staff = staffChannel;

            logger.discord(`Validated Discord channels - Chat: ${chatChannel.name}, Staff: ${staffChannel.name}`);

        } catch (error) {
            logger.logError(error, 'Failed to validate Discord channels');
            throw error;
        }
    }

    // ==================== MAIN SENDING METHODS ====================

    /**
     * Send guild chat message to Discord
     * @param {object} messageData - Parsed guild message data
     * @param {object} guildConfig - Guild configuration
     * @returns {Promise} Send promise
     */
    async sendGuildMessage(messageData, guildConfig) {
        if (!this.client) {
            throw new Error('Discord client not initialized');
        }

        try {
            // Determine target channel based on chat type
            const channelType = messageData.chatType === 'officer' ? 'staff' : 'chat';
            const channel = this.channels[channelType];

            if (!channel) {
                throw new Error(`Discord ${channelType} channel not available`);
            }

            // Check rate limiting
            if (this.isRateLimited(channel.id)) {
                logger.warn(`Rate limit hit for Discord channel ${channel.name}`);
                return null;
            }

            // Get formatted message
            const formattedMessage = this.messageFormatter.formatGuildMessage(messageData, guildConfig, guildConfig, 'messagesToDiscord');
            if (!formattedMessage) {
                logger.warn(`No formatted message generated for Discord`);
                return null;
            }

            let result;

            // Use webhook if available and preferred
            if (this.webhookSender && this.webhookSender.hasWebhook(channelType) && 
                this.config.get('bridge.webhook.useForGuildMessages') !== false) {
                
                result = await this.sendViaWebhook(messageData, guildConfig, channelType);
            } else {
                // Send via regular channel
                result = await this.sendViaChannel(formattedMessage, channel);
            }

            // Update rate limiting
            this.updateRateLimit(channel.id);

            logger.discord(`[DISCORD] Sent guild message to ${channelType} channel: "${formattedMessage}"`);

            return result;

        } catch (error) {
            logger.logError(error, 'Failed to send guild message to Discord');
            throw error;
        }
    }

    /**
     * Send event to Discord
     * @param {object} eventData - Parsed event data
     * @param {object} guildConfig - Guild configuration
     * @returns {Promise} Send promise
     */
    async sendEvent(eventData, guildConfig) {
        if (!this.client) {
            throw new Error('Discord client not initialized');
        }

        try {
            const channel = this.channels.chat; // Events go to chat channel

            if (!channel) {
                throw new Error('Discord chat channel not available');
            }

            // Check rate limiting
            if (this.isRateLimited(channel.id)) {
                logger.warn(`Rate limit hit for Discord channel ${channel.name}`);
                return null;
            }

            // Get formatted message
            const formattedMessage = this.messageFormatter.formatGuildEvent(eventData, guildConfig, guildConfig, 'messagesToDiscord');

            if (!formattedMessage) {
                logger.warn(`No formatted event message generated for Discord`);
                return null;
            }

            // Send the message
            const result = await this.sendViaChannel(formattedMessage, channel);

            // Update rate limiting
            this.updateRateLimit(channel.id);

            logger.discord(`[DISCORD] Sent event to chat channel: "${formattedMessage}"`);

            return result;

        } catch (error) {
            logger.logError(error, 'Failed to send event to Discord');
            throw error;
        }
    }

    /**
     * Send system message to Discord
     * @param {string} type - System message type
     * @param {object} data - Message data
     * @param {string} channelType - Target channel type ('chat' or 'staff')
     * @returns {Promise} Send promise
     */
    async sendSystemMessage(type, data, channelType = 'chat') {
        if (!this.client) {
            throw new Error('Discord client not initialized');
        }

        try {
            const channel = this.channels[channelType];

            if (!channel) {
                throw new Error(`Discord ${channelType} channel not available`);
            }

            // Check rate limiting
            if (this.isRateLimited(channel.id)) {
                logger.warn(`Rate limit hit for Discord channel ${channel.name}`);
                return null;
            }

            // Get formatted system message
            const formattedMessage = this.messageFormatter.formatSystem(type, data, 'discord');

            if (!formattedMessage) {
                logger.warn(`[DISCORD] No formatted system message generated for ${type}`);
                return null;
            }

            // Send via channel
            const result = await this.sendViaChannel(formattedMessage, channel);

            logger.discord(`[DISCORD] Sent system message to ${channelType} channel: "${formattedMessage}"`);

            return result;

        } catch (error) {
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
        if (!this.client) {
            throw new Error('Discord client not initialized');
        }

        try {
            const channel = this.channels.chat; // Connection status goes to chat channel

            if (!channel) {
                throw new Error('Discord chat channel not available');
            }

            let message;
            let embed = null;

            switch (status) {
                case 'connected':
                    message = `✅ **${guildConfig.name}** bot connected to Hypixel`;
                    embed = this.embedBuilder.createConnectionEmbed(guildConfig, status, details);
                    break;
                    
                case 'disconnected':
                    const reason = details.reason ? ` (${details.reason})` : '';
                    message = `❌ **${guildConfig.name}** bot disconnected from Hypixel${reason}`;
                    embed = this.embedBuilder.createConnectionEmbed(guildConfig, status, details);
                    break;
                    
                case 'reconnecting':
                    message = `🔄 **${guildConfig.name}** bot reconnecting to Hypixel...`;
                    break;
                    
                case 'error':
                    const errorMsg = details.error ? ` - ${details.error}` : '';
                    message = `⚠️ **${guildConfig.name}** connection error${errorMsg}`;
                    embed = this.embedBuilder.createConnectionEmbed(guildConfig, status, details);
                    break;
                    
                default:
                    message = `ℹ️ **${guildConfig.name}** status: ${status}`;
            }

            // Send the message
            const result = await this.sendViaChannel(message, channel, embed);

            logger.discord(`[DISCORD] Sent connection status to chat channel: "${message}"`);

            return result;

        } catch (error) {
            logger.logError(error, 'Failed to send connection status to Discord');
            throw error;
        }
    }

    // ==================== INTERNAL SENDING METHODS ====================

    /**
     * Send message via webhook
     * @param {object} messageData - Message data
     * @param {object} guildConfig - Guild configuration
     * @param {string} channelType - Channel type
     * @returns {Promise} Send promise
     */
    async sendViaWebhook(messageData, guildConfig, channelType) {
        if (!this.webhookSender) {
            throw new Error('Webhook sender not available');
        }

        const webhook = this.webhookSender.getWebhook(channelType);
        if (!webhook) {
            throw new Error(`Webhook not available for ${channelType} channel`);
        }

        // Format message content
        const content = this.messageFormatter.formatGuildMessage(messageData, guildConfig, guildConfig, 'messagesToDiscord');

        // Send via webhook
        return await this.webhookSender.sendMessage(
            content,
            messageData,
            guildConfig,
            channelType
        );
    }

    /**
     * Send message via channel
     * @param {string} content - Message content
     * @param {Channel} channel - Discord channel
     * @param {object} embed - Optional embed
     * @returns {Promise} Send promise
     */
    async sendViaChannel(content, channel, embed = null) {
        const options = { content };

        if (embed) {
            options.embeds = [embed];
        }

        return await channel.send(options);
    }

    // ==================== UTILITY METHODS ====================

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

        this.client = null;
        this.channels = { chat: null, staff: null };

        logger.debug('Discord MessageSender cleaned up');
    }
}

module.exports = MessageSender;