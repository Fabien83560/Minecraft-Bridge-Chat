// Globals Imports
const { WebhookClient } = require('discord.js');

// Specific Imports
const BridgeLocator = require("../../../bridgeLocator.js");
const logger = require("../../../shared/logger");

class WebhookSender {
    constructor() {
        const mainBridge = BridgeLocator.getInstance();
        this.config = mainBridge.config;

        this.client = null;
        this.webhooks = {
            chat: null,
            staff: null
        };

        this.webhookConfig = this.config.get('bridge.webhook') || {};
        this.avatarAPI = this.webhookConfig.avatarAPI || 'https://minotar.net/helm/{username}/64.png';

        // Cache for user avatars to reduce API calls
        this.avatarCache = new Map();
        this.avatarCacheTimeout = 5 * 60 * 1000; // 5 minutes

        logger.debug('WebhookSender initialized');
    }

    async initialize(client) {
        this.client = client;

        try {
            await this.setupWebhooks();
            logger.discord('WebhookSender initialized with Discord client');
        } catch (error) {
            logger.logError(error, 'Failed to initialize WebhookSender');
            throw error;
        }
    }

    async setupWebhooks() {
        const bridgeConfig = this.config.get('bridge.channels');

        // Setup chat channel webhook
        if (bridgeConfig.chat.webhookUrl) {
            try {
                this.webhooks.chat = new WebhookClient({ url: bridgeConfig.chat.webhookUrl });
                logger.debug('Chat channel webhook initialized');
            } catch (error) {
                logger.logError(error, 'Failed to initialize chat webhook');
            }
        } else {
            // Try to create webhook for chat channel
            await this.createWebhookForChannel('chat');
        }

        // Setup staff channel webhook
        if (bridgeConfig.staff.webhookUrl) {
            try {
                this.webhooks.staff = new WebhookClient({ url: bridgeConfig.staff.webhookUrl });
                logger.debug('Staff channel webhook initialized');
            } catch (error) {
                logger.logError(error, 'Failed to initialize staff webhook');
            }
        } else {
            // Try to create webhook for staff channel
            await this.createWebhookForChannel('staff');
        }

        logger.discord(`WebhookSender setup complete - Chat: ${!!this.webhooks.chat}, Staff: ${!!this.webhooks.staff}`);
    }

    async createWebhookForChannel(channelType) {
        try {
            const bridgeConfig = this.config.get('bridge.channels');
            const channelId = bridgeConfig[channelType].id;

            const channel = await this.client.channels.fetch(channelId);
            if (!channel || !channel.isTextBased()) {
                throw new Error(`Invalid channel for webhook creation: ${channelType}`);
            }

            // Check if we have permission to create webhooks
            const botMember = await channel.guild.members.fetch(this.client.user.id);
            if (!botMember.permissions.has('ManageWebhooks')) {
                logger.warn(`Missing ManageWebhooks permission for ${channelType} channel`);
                return;
            }

            // Create webhook
            const webhook = await channel.createWebhook({
                name: `Minecraft Bridge - ${channelType.charAt(0).toUpperCase() + channelType.slice(1)}`,
                avatar: 'https://minotar.net/helm/steve/64.png', // Default Minecraft avatar
                reason: 'Created by Minecraft Bridge Chat bot for message relaying'
            });

            this.webhooks[channelType] = webhook;
            
            logger.discord(`Created webhook for ${channelType} channel: ${webhook.id}`);
            logger.info(`💡 Add this webhook URL to your config: ${webhook.url}`);

        } catch (error) {
            logger.logError(error, `Failed to create webhook for ${channelType} channel`);
        }
    }

    /**
     * Send message via webhook
     * @param {string} message - Formatted message content
     * @param {object} messageData - Original message data
     * @param {object} guildConfig - Guild configuration
     * @param {string} channelType - Channel type (chat/staff)
     * @returns {Promise} Send promise
     */
    async sendMessage(message, messageData, guildConfig, channelType) {
        try {
            const webhook = this.webhooks[channelType];
            if (!webhook) {
                throw new Error(`No webhook available for ${channelType} channel`);
            }

            // Build webhook payload
            const payload = await this.buildWebhookPayload(message, messageData, guildConfig);

            // Send via webhook
            const result = await webhook.send(payload);
            
            logger.debug(`[DISCORD] Sent webhook message to ${channelType} channel as ${payload.username}`);

            return result;

        } catch (error) {
            logger.logError(error, `Failed to send webhook message to ${channelType} channel`);
            throw error;
        }
    }

    /**
     * Build webhook payload
     * @param {string} message - Message content
     * @param {object} messageData - Original message data
     * @param {object} guildConfig - Guild configuration
     * @returns {object} Webhook payload
     */
    async buildWebhookPayload(message, messageData, guildConfig) {
        const username = messageData.username || 'Unknown';
        const avatarUrl = await this.getUserAvatar(username);

        const payload = {
            content: message,
            username: this.formatWebhookUsername(username, guildConfig),
            avatarURL: avatarUrl,
            allowedMentions: {
                parse: [] // Disable all mentions for security
            }
        };

        // Add thread support if message is in a thread
        // This would be expanded based on Discord.js version and thread requirements

        return payload;
    }

    /**
     * Format username for webhook display
     * @param {string} username - Original username
     * @param {object} guildConfig - Guild configuration
     * @returns {string} Formatted username
     */
    formatWebhookUsername(username, guildConfig) {
        const interGuildConfig = this.config.get('bridge.interGuild');
        
        // Add guild tag if enabled
        if (interGuildConfig.showSourceTag && guildConfig.tag) {
            return `[${guildConfig.tag}] ${username}`;
        }

        return username;
    }

    /**
     * Get user avatar URL with caching
     * @param {string} username - Minecraft username
     * @returns {string} Avatar URL
     */
    async getUserAvatar(username) {
        if (!username) {
            return this.getDefaultAvatar();
        }

        // Check cache first
        const cacheKey = username.toLowerCase();
        const cachedAvatar = this.avatarCache.get(cacheKey);
        
        if (cachedAvatar && (Date.now() - cachedAvatar.timestamp) < this.avatarCacheTimeout) {
            return cachedAvatar.url;
        }

        // Generate avatar URL
        const avatarUrl = this.avatarAPI.replace('{username}', username);

        // Cache the avatar
        this.avatarCache.set(cacheKey, {
            url: avatarUrl,
            timestamp: Date.now()
        });

        return avatarUrl;
    }

    /**
     * Get default avatar URL
     * @returns {string} Default avatar URL
     */
    getDefaultAvatar() {
        return 'https://minotar.net/helm/steve/64.png';
    }

    /**
     * Clean up avatar cache
     */
    cleanupAvatarCache() {
        const now = Date.now();
        let cleaned = 0;

        for (const [key, data] of this.avatarCache.entries()) {
            if (now - data.timestamp > this.avatarCacheTimeout) {
                this.avatarCache.delete(key);
                cleaned++;
            }
        }

        if (cleaned > 0) {
            logger.debug(`Cleaned up ${cleaned} expired avatar cache entries`);
        }
    }

    /**
     * Update webhook configuration
     * @param {object} newConfig - New webhook configuration
     */
    async updateConfig(newConfig) {
        const oldAvatarAPI = this.avatarAPI;
        
        this.webhookConfig = { ...this.webhookConfig, ...newConfig };
        this.avatarAPI = newConfig.avatarAPI || this.avatarAPI;

        // Clear avatar cache if API changed
        if (oldAvatarAPI !== this.avatarAPI) {
            this.avatarCache.clear();
            logger.debug('Avatar cache cleared due to API change');
        }

        logger.debug('WebhookSender configuration updated');
    }

    /**
     * Cleanup resources
     */
    cleanup() {
        // Clear avatar cache
        this.avatarCache.clear();

        // Destroy webhook clients
        for (const [channelType, webhook] of Object.entries(this.webhooks)) {
            if (webhook && typeof webhook.destroy === 'function') {
                try {
                    webhook.destroy();
                } catch (error) {
                    logger.debug(`Error destroying ${channelType} webhook: ${error.message}`);
                }
            }
        }

        this.webhooks = { chat: null, staff: null };

        logger.debug('WebhookSender cleaned up');
    }

    /**
     * Check if webhook is available for channel type
     * @param {string} channelType - Channel type
     * @returns {boolean} Whether webhook is available
     */
    hasWebhook(channelType) {
        return !!this.webhooks[channelType];
    }

    /**
     * Get webhook client for channel type
     * @param {string} channelType - Channel type
     * @returns {WebhookClient|null} Webhook client or null
     */
    getWebhook(channelType) {
        return this.webhooks[channelType] || null;
    }
}

module.exports = WebhookSender;