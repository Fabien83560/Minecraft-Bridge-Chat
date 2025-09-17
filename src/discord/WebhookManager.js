// Globals Imports
const { WebhookClient, EmbedBuilder } = require('discord.js');

// Specific Imports
const logger = require("../shared/logger");
const { getTemplateLoader } = require("../config/TemplateLoader.js");

class WebhookManager {
    constructor(bridgeConfig) {
        this.bridgeConfig = bridgeConfig;
        this.templateLoader = getTemplateLoader();
        
        this.client = null;
        this.webhookClients = new Map();
        
        // Configuration
        this.webhookConfig = bridgeConfig.webhook || {};
        this.isEnabled = this.webhookConfig.enabled !== false; // enabled by default
        this.avatarAPI = this.webhookConfig.avatarAPI || 'https://minotar.net/helm/{username}/64.png';
        
        // Rate limiting per webhook
        this.rateLimits = new Map(); // webhookUrl -> { messages: [], lastReset: timestamp }
        this.rateLimit = { messages: 5, window: 60000 }; // 5 messages per minute per webhook
        
        // Statistics
        this.stats = {
            messagesPosted: 0,
            webhooksCreated: 0,
            rateLimitHits: 0,
            errors: 0,
            avatarCacheMisses: 0
        };

        // Avatar cache
        this.avatarCache = new Map(); // username -> avatar URL
        this.avatarCacheExpiry = 30 * 60 * 1000; // 30 minutes

        logger.debug('WebhookManager initialized', {
            enabled: this.isEnabled,
            avatarAPI: this.avatarAPI
        });
    }

    setClient(discordClient) {
        this.client = discordClient;
        this.initializeWebhooks();
    }

    initializeWebhooks() {
        if (!this.isEnabled) {
            logger.debug('Webhook functionality disabled');
            return;
        }

        // Initialize chat webhook
        const chatConfig = this.bridgeConfig.channels?.chat;
        if (chatConfig?.webhookUrl) {
            this.createWebhookClient('chat', chatConfig.webhookUrl);
        }

        // Initialize staff webhook  
        const staffConfig = this.bridgeConfig.channels?.staff;
        if (staffConfig?.webhookUrl) {
            this.createWebhookClient('staff', staffConfig.webhookUrl);
        }

        logger.discord(`✅ Initialized ${this.webhookClients.size} webhook clients`);
    }

    createWebhookClient(name, webhookUrl) {
        try {
            const webhookClient = new WebhookClient({ url: webhookUrl });
            this.webhookClients.set(name, {
                client: webhookClient,
                url: webhookUrl,
                lastUsed: 0,
                messageCount: 0
            });

            this.stats.webhooksCreated++;
            logger.debug(`Created webhook client for ${name}`);

        } catch (error) {
            logger.logError(error, `Failed to create webhook client for ${name}`);
        }
    }

    /**
     * Send a guild message via webhook
     * @param {object} messageData - Parsed message data
     * @param {object} sourceGuildConfig - Source guild configuration
     * @param {string} channelType - Channel type ('chat' or 'staff')
     * @returns {Promise<boolean>} Success status
     */
    async sendGuildMessage(messageData, sourceGuildConfig, channelType = 'chat') {
        if (!this.isEnabled) {
            logger.debug('Webhooks disabled, skipping guild message');
            return false;
        }

        try {
            // Get webhook client
            const webhookInfo = this.webhookClients.get(channelType);
            if (!webhookInfo) {
                logger.warn(`No webhook configured for channel type: ${channelType}`);
                return false;
            }

            // Check rate limiting
            if (this.isRateLimited(webhookInfo.url)) {
                this.stats.rateLimitHits++;
                logger.debug(`Webhook rate limited for ${channelType}`);
                return false;
            }

            // Format message using templates
            const formattedContent = this.formatMessage(messageData, sourceGuildConfig, messageData.chatType || 'guild');
            if (!formattedContent) {
                logger.warn('No formatted content generated for Discord message');
                return false;
            }

            // Get player avatar
            const avatarUrl = await this.getPlayerAvatar(messageData.username);

            // Create display name with tag if enabled
            const displayName = this.createDisplayName(messageData.username, sourceGuildConfig);

            // Send via webhook
            const webhookMessage = await webhookInfo.client.send({
                content: formattedContent,
                username: displayName,
                avatarURL: avatarUrl
            });

            // Update statistics and rate limiting
            this.updateWebhookStats(webhookInfo);
            this.updateRateLimit(webhookInfo.url);
            this.stats.messagesPosted++;

            logger.discord(`✅ Guild message sent via webhook: ${displayName} -> "${formattedContent}"`);
            return true;

        } catch (error) {
            logger.logError(error, `Failed to send guild message via webhook`);
            this.stats.errors++;
            return false;
        }
    }

    /**
     * Send a guild event via webhook
     * @param {object} eventData - Parsed event data
     * @param {object} sourceGuildConfig - Source guild configuration
     * @param {string} channelType - Channel type ('chat' or 'staff')
     * @returns {Promise<boolean>} Success status
     */
    async sendGuildEvent(eventData, sourceGuildConfig, channelType = 'chat') {
        if (!this.isEnabled) {
            logger.debug('Webhooks disabled, skipping guild event');
            return false;
        }

        try {
            // Get webhook client
            const webhookInfo = this.webhookClients.get(channelType);
            if (!webhookInfo) {
                logger.warn(`No webhook configured for channel type: ${channelType}`);
                return false;
            }

            // Check rate limiting
            if (this.isRateLimited(webhookInfo.url)) {
                this.stats.rateLimitHits++;
                logger.debug(`Webhook rate limited for ${channelType}`);
                return false;
            }

            // Format event using templates
            const formattedContent = this.formatEvent(eventData, sourceGuildConfig);
            if (!formattedContent) {
                logger.warn(`No formatted content generated for Discord event: ${eventData.type}`);
                return false;
            }

            // For events, use guild bot name and guild icon
            const displayName = this.createEventDisplayName(sourceGuildConfig);
            const avatarUrl = await this.getGuildAvatar(sourceGuildConfig);

            // Send via webhook
            const webhookMessage = await webhookInfo.client.send({
                content: formattedContent,
                username: displayName,
                avatarURL: avatarUrl
            });

            // Update statistics and rate limiting
            this.updateWebhookStats(webhookInfo);
            this.updateRateLimit(webhookInfo.url);
            this.stats.messagesPosted++;

            logger.discord(`✅ Guild event sent via webhook: ${displayName} -> "${formattedContent}"`);
            return true;

        } catch (error) {
            logger.logError(error, `Failed to send guild event via webhook`);
            this.stats.errors++;
            return false;
        }
    }

    /**
     * Send system message via webhook
     * @param {string} content - Message content
     * @param {string} channelType - Channel type ('chat' or 'staff') 
     * @param {object} options - Additional options
     * @returns {Promise<boolean>} Success status
     */
    async sendSystemMessage(content, channelType = 'chat', options = {}) {
        if (!this.isEnabled) {
            logger.debug('Webhooks disabled, skipping system message');
            return false;
        }

        try {
            const webhookInfo = this.webhookClients.get(channelType);
            if (!webhookInfo) {
                logger.warn(`No webhook configured for channel type: ${channelType}`);
                return false;
            }

            if (this.isRateLimited(webhookInfo.url)) {
                this.stats.rateLimitHits++;
                logger.debug(`Webhook rate limited for ${channelType}`);
                return false;
            }

            const webhookMessage = await webhookInfo.client.send({
                content: content,
                username: options.username || 'System',
                avatarURL: options.avatarURL || 'https://cdn.discordapp.com/embed/avatars/0.png',
                embeds: options.embeds || undefined
            });

            this.updateWebhookStats(webhookInfo);
            this.updateRateLimit(webhookInfo.url);
            this.stats.messagesPosted++;

            logger.discord(`✅ System message sent via webhook: "${content}"`);
            return true;

        } catch (error) {
            logger.logError(error, `Failed to send system message via webhook`);
            this.stats.errors++;
            return false;
        }
    }

    /**
     * Format guild message using templates
     * @param {object} messageData - Message data
     * @param {object} sourceGuildConfig - Source guild config
     * @param {string} messageType - Message type (guild, officer)
     * @returns {string|null} Formatted message
     */
    formatMessage(messageData, sourceGuildConfig, messageType) {
        try {
            const serverName = sourceGuildConfig.server?.serverName || 'Unknown';
            
            // Get template configuration
            const templateConfig = {
                showTags: this.bridgeConfig.interGuild?.showTags || false,
                showSourceTag: this.bridgeConfig.interGuild?.showSourceTag || false
            };

            // Get best template for Discord
            const template = this.templateLoader.getBestTemplate(
                'messagesToDiscord',
                serverName,
                messageType,
                templateConfig
            );

            if (!template) {
                // Fallback formatting
                return this.createFallbackMessage(messageData, sourceGuildConfig);
            }

            // Build variables for template substitution
            const variables = {
                username: messageData.username || 'Unknown',
                message: messageData.message || '',
                guildName: sourceGuildConfig.name,
                guildTag: sourceGuildConfig.tag,
                sourceGuildTag: sourceGuildConfig.tag,
                timestamp: new Date().toLocaleTimeString(),
                date: new Date().toLocaleDateString()
            };

            // Add tag if enabled
            if (templateConfig.showTags && sourceGuildConfig.tag) {
                variables.tag = sourceGuildConfig.tag;
            } else {
                variables.tag = '';
            }

            // Substitute variables in template
            let formatted = template;
            for (const [key, value] of Object.entries(variables)) {
                const placeholder = `{${key}}`;
                formatted = formatted.replace(new RegExp(placeholder.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), value || '');
            }

            return formatted;

        } catch (error) {
            logger.logError(error, 'Error formatting message for Discord');
            return this.createFallbackMessage(messageData, sourceGuildConfig);
        }
    }

    /**
     * Format guild event using templates
     * @param {object} eventData - Event data
     * @param {object} sourceGuildConfig - Source guild config
     * @returns {string|null} Formatted event message
     */
    formatEvent(eventData, sourceGuildConfig) {
        try {
            const serverName = sourceGuildConfig.server?.serverName || 'Unknown';
            
            const templateConfig = {
                showTags: this.bridgeConfig.interGuild?.showTags || false,
                showSourceTag: this.bridgeConfig.interGuild?.showSourceTag || false
            };

            const template = this.templateLoader.getEventTemplate(
                'messagesToDiscord',
                serverName,
                eventData.type,
                templateConfig
            );

            if (!template) {
                return this.createFallbackEvent(eventData, sourceGuildConfig);
            }

            const variables = {
                username: eventData.username || 'Unknown',
                guildName: sourceGuildConfig.name,
                guildTag: sourceGuildConfig.tag,
                sourceGuildTag: sourceGuildConfig.tag,
                eventType: eventData.type,
                timestamp: new Date().toLocaleTimeString(),
                date: new Date().toLocaleDateString()
            };

            // Add event-specific variables
            switch (eventData.type) {
                case 'promote':
                case 'demote':
                    variables.toRank = eventData.toRank || 'Unknown';
                    variables.fromRank = eventData.fromRank || 'Unknown';
                    break;
                case 'level':
                    variables.level = eventData.level || '1';
                    break;
                case 'motd':
                    variables.changer = eventData.changer || 'Unknown';
                    variables.motd = eventData.motd || '';
                    break;
            }

            // Add tag if enabled
            if (templateConfig.showTags && sourceGuildConfig.tag) {
                variables.tag = sourceGuildConfig.tag;
            } else {
                variables.tag = '';
            }

            // Substitute variables
            let formatted = template;
            for (const [key, value] of Object.entries(variables)) {
                const placeholder = `{${key}}`;
                formatted = formatted.replace(new RegExp(placeholder.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), value || '');
            }

            return formatted;

        } catch (error) {
            logger.logError(error, 'Error formatting event for Discord');
            return this.createFallbackEvent(eventData, sourceGuildConfig);
        }
    }

    /**
     * Get player avatar URL
     * @param {string} username - Player username
     * @returns {Promise<string>} Avatar URL
     */
    async getPlayerAvatar(username) {
        if (!username) {
            return 'https://cdn.discordapp.com/embed/avatars/0.png';
        }

        // Check cache first
        const cachedAvatar = this.avatarCache.get(username.toLowerCase());
        if (cachedAvatar && (Date.now() - cachedAvatar.timestamp) < this.avatarCacheExpiry) {
            return cachedAvatar.url;
        }

        try {
            // Generate avatar URL from API template
            const avatarUrl = this.avatarAPI.replace('{username}', username);
            
            // Cache the avatar
            this.avatarCache.set(username.toLowerCase(), {
                url: avatarUrl,
                timestamp: Date.now()
            });

            return avatarUrl;

        } catch (error) {
            logger.debug(`Error getting avatar for ${username}: ${error.message}`);
            this.stats.avatarCacheMisses++;
            return 'https://cdn.discordapp.com/embed/avatars/0.png';
        }
    }

    /**
     * Get guild avatar (for events)
     * @param {object} guildConfig - Guild configuration
     * @returns {Promise<string>} Avatar URL
     */
    async getGuildAvatar(guildConfig) {
        // For guild events, we can use a generic guild icon or the bot's avatar
        try {
            if (guildConfig.account?.username) {
                return await this.getPlayerAvatar(guildConfig.account.username);
            }
        } catch (error) {
            logger.debug(`Error getting guild avatar: ${error.message}`);
        }

        return 'https://cdn.discordapp.com/embed/avatars/1.png';
    }

    /**
     * Create display name for player messages
     * @param {string} username - Player username
     * @param {object} sourceGuildConfig - Source guild config
     * @returns {string} Display name
     */
    createDisplayName(username, sourceGuildConfig) {
        const showTags = this.bridgeConfig.interGuild?.showTags || false;
        
        if (showTags && sourceGuildConfig.tag) {
            return `${username} [${sourceGuildConfig.tag}]`;
        }
        
        return username;
    }

    /**
     * Create display name for events
     * @param {object} sourceGuildConfig - Source guild config
     * @returns {string} Display name
     */
    createEventDisplayName(sourceGuildConfig) {
        return `${sourceGuildConfig.name} Events`;
    }

    /**
     * Create fallback message when template fails
     * @param {object} messageData - Message data
     * @param {object} sourceGuildConfig - Guild config
     * @returns {string} Fallback message
     */
    createFallbackMessage(messageData, sourceGuildConfig) {
        const showTags = this.bridgeConfig.interGuild?.showTags || false;
        const tag = showTags && sourceGuildConfig.tag ? ` \`[${sourceGuildConfig.tag}]\`` : '';
        
        return `**${messageData.username}**${tag}: ${messageData.message}`;
    }

    /**
     * Create fallback event when template fails
     * @param {object} eventData - Event data
     * @param {object} sourceGuildConfig - Guild config
     * @returns {string} Fallback event
     */
    createFallbackEvent(eventData, sourceGuildConfig) {
        const showTags = this.bridgeConfig.interGuild?.showTags || false;
        const tagPrefix = showTags && sourceGuildConfig.tag ? `\`[${sourceGuildConfig.tag}]\` ` : '';
        
        switch (eventData.type) {
            case 'join':
                return `${tagPrefix}**${eventData.username} joined the guild!** 👋`;
            case 'leave':
                return `${tagPrefix}**${eventData.username} left the guild** 👋`;
            case 'kick':
                return `${tagPrefix}**${eventData.username} was kicked** 🚫`;
            case 'promote':
                return `${tagPrefix}**${eventData.username} was promoted to ${eventData.toRank}** ⬆️`;
            case 'demote':
                return `${tagPrefix}**${eventData.username} was demoted to ${eventData.toRank}** ⬇️`;
            case 'level':
                return `${tagPrefix}**Guild reached level ${eventData.level}!** 🎉`;
            default:
                return `${tagPrefix}**Guild event: ${eventData.type}**`;
        }
    }

    /**
     * Check if webhook is rate limited
     * @param {string} webhookUrl - Webhook URL
     * @returns {boolean} Whether rate limited
     */
    isRateLimited(webhookUrl) {
        const now = Date.now();
        const rateLimitData = this.rateLimits.get(webhookUrl);
        
        if (!rateLimitData) {
            return false;
        }

        // Clean old messages outside window
        const validMessages = rateLimitData.messages.filter(time => now - time < this.rateLimit.window);
        rateLimitData.messages = validMessages;

        return validMessages.length >= this.rateLimit.messages;
    }

    /**
     * Update rate limiting data
     * @param {string} webhookUrl - Webhook URL
     */
    updateRateLimit(webhookUrl) {
        const now = Date.now();
        const rateLimitData = this.rateLimits.get(webhookUrl) || { messages: [] };
        
        rateLimitData.messages.push(now);
        this.rateLimits.set(webhookUrl, rateLimitData);
    }

    /**
     * Update webhook statistics
     * @param {object} webhookInfo - Webhook info object
     */
    updateWebhookStats(webhookInfo) {
        webhookInfo.lastUsed = Date.now();
        webhookInfo.messageCount++;
    }

    /**
     * Health check for webhooks
     * @returns {Promise<object>} Health status
     */
    async healthCheck() {
        const health = {
            healthy: true,
            issues: []
        };

        if (!this.isEnabled) {
            health.issues.push('Webhook functionality disabled');
            return health;
        }

        if (this.webhookClients.size === 0) {
            health.healthy = false;
            health.issues.push('No webhook clients configured');
        }

        // Test each webhook
        for (const [name, webhookInfo] of this.webhookClients) {
            try {
                // Simple test - fetch webhook info
                await webhookInfo.client.fetchMessage('@original');
            } catch (error) {
                if (error.code !== 10008) { // Unknown Message error is expected for @original
                    health.issues.push(`Webhook ${name} may be invalid: ${error.message}`);
                }
            }
        }

        if (this.stats.errors > 5) {
            health.issues.push(`High error count: ${this.stats.errors}`);
        }

        return health;
    }

    /**
     * Get webhook statistics
     * @returns {object} Statistics
     */
    getStatistics() {
        return {
            ...this.stats,
            activeWebhooks: this.webhookClients.size,
            rateLimitQueues: this.rateLimits.size,
            avatarCacheSize: this.avatarCache.size,
            webhooks: Array.from(this.webhookClients.entries()).map(([name, info]) => ({
                name,
                messageCount: info.messageCount,
                lastUsed: info.lastUsed
            }))
        };
    }

    /**
     * Stop webhook manager
     */
    stop() {
        // Clear caches and rate limits
        this.avatarCache.clear();
        this.rateLimits.clear();
        
        // Destroy webhook clients
        for (const [name, webhookInfo] of this.webhookClients) {
            try {
                webhookInfo.client.destroy();
            } catch (error) {
                logger.debug(`Error destroying webhook ${name}: ${error.message}`);
            }
        }
        
        this.webhookClients.clear();
        logger.debug('WebhookManager stopped');
    }
}

module.exports = WebhookManager;