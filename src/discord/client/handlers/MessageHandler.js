// Globals Imports
const { EmbedBuilder: DiscordEmbedBuilder } = require('discord.js');
const EventEmitter = require('events');

// Specific Imports
const BridgeLocator = require("../../../bridgeLocator.js");
const MessageFormatter = require("../../../shared/MessageFormatter.js");
const logger = require("../../../shared/logger");

class MessageHandler extends EventEmitter {
    constructor() {
        super();

        const mainBridge = BridgeLocator.getInstance();
        this.config = mainBridge.config;

        this.client = null;
        this.messageFormatter = null;

        this.channels = {
            chat: null,
            staff: null
        };

        // Message filtering
        this.botUsers = new Set(); // Bot users to ignore
        this.commandPrefix = this.config.get('bridge.commandPrefix') || '!';
        
        // Statistics
        this.stats = {
            messagesReceived: 0,
            messagesProcessed: 0,
            commandsReceived: 0,
            messagesFiltered: 0,
            errors: 0
        };

        // Initialize components that don't require Discord client
        this.initializeComponents();
    }

    /**
     * Initialize components that don't require Discord client
     */
    initializeComponents() {
        try {
            // Initialize message formatter for processing Discord messages
            const formatterConfig = {
                showTags: this.config.get('bridge.interGuild.showTags') || false,
                showSourceTag: false, // We don't need source tags for incoming messages
                enableDebugLogging: this.config.get('features.messageSystem.enableDebugLogging') || false,
                maxMessageLength: 256, // Minecraft chat limit
                fallbackToBasic: true
            };

            this.messageFormatter = new MessageFormatter(formatterConfig);

            logger.debug('MessageHandler components initialized');

        } catch (error) {
            logger.logError(error, 'Failed to initialize MessageHandler components');
            throw error;
        }
    }

    /**
     * Initialize with Discord client
     * @param {Client} client - Discord client instance
     */
    async initialize(client) {
        if (!client) {
            throw new Error('Discord client is required for MessageHandler initialization');
        }

        this.client = client;

        try {
            // Get and cache channels
            await this.validateAndCacheChannels();

            // Add bot user to ignore list
            if (client.user) {
                this.botUsers.add(client.user.id);
            }

            logger.discord('MessageHandler initialized with Discord client');

        } catch (error) {
            logger.logError(error, 'Failed to initialize MessageHandler with client');
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
            // Get chat channel
            if (bridgeConfig.chat && bridgeConfig.chat.id) {
                const chatChannel = await this.client.channels.fetch(bridgeConfig.chat.id);
                if (chatChannel) {
                    this.channels.chat = chatChannel;
                    logger.debug(`Cached chat channel: ${chatChannel.name}`);
                }
            }

            // Get staff channel
            if (bridgeConfig.staff && bridgeConfig.staff.id) {
                const staffChannel = await this.client.channels.fetch(bridgeConfig.staff.id);
                if (staffChannel) {
                    this.channels.staff = staffChannel;
                    logger.debug(`Cached staff channel: ${staffChannel.name}`);
                }
            }

            logger.discord(`MessageHandler channels validated - Chat: ${!!this.channels.chat}, Staff: ${!!this.channels.staff}`);

        } catch (error) {
            logger.logError(error, 'Failed to validate Discord channels in MessageHandler');
            throw error;
        }
    }

    // ==================== MESSAGE PROCESSING METHODS ====================

    /**
     * Handle incoming Discord message
     * @param {Message} message - Discord message object
     */
    async handleMessage(message) {
        try {
            this.stats.messagesReceived++;

            // Filter out messages we should ignore
            if (!this.shouldProcessMessage(message)) {
                this.stats.messagesFiltered++;
                return;
            }

            // Check if it's a command
            if (message.content.startsWith(this.commandPrefix)) {
                this.stats.commandsReceived++;
                this.emit('command', {
                    message,
                    command: message.content.substring(this.commandPrefix.length).trim(),
                    author: message.author,
                    channel: message.channel
                });
                return;
            }

            // Process regular message
            const processedMessage = this.processMessage(message);
            if (processedMessage) {
                this.stats.messagesProcessed++;
                this.emit('message', processedMessage);
                
                logger.discord(`[DISCORD] Received message from ${message.author.displayName}: "${message.content}"`);
            }

        } catch (error) {
            this.stats.errors++;
            logger.logError(error, 'Error handling Discord message');
        }
    }

    /**
     * Check if message should be processed
     * @param {Message} message - Discord message
     * @returns {boolean} Whether to process the message
     */
    shouldProcessMessage(message) {
        // Ignore bot messages
        if (message.author.bot || this.botUsers.has(message.author.id)) {
            return false;
        }

        // Ignore empty messages
        if (!message.content || message.content.trim().length === 0) {
            return false;
        }

        // Only process messages from configured channels
        const channelId = message.channel.id;
        const chatChannelId = this.channels.chat?.id;
        const staffChannelId = this.channels.staff?.id;

        if (channelId !== chatChannelId && channelId !== staffChannelId) {
            return false;
        }

        // Ignore webhook messages if configured to do so
        if (message.webhookId && this.config.get('bridge.ignoreWebhookMessages') !== false) {
            return false;
        }

        return true;
    }

    /**
     * Process Discord message into bridge format
     * @param {Message} message - Discord message
     * @returns {object|null} Processed message data
     */
    processMessage(message) {
        try {
            const channelId = message.channel.id;
            const chatChannelId = this.channels.chat?.id;
            const staffChannelId = this.channels.staff?.id;

            // Determine channel type
            let channelType = 'unknown';
            if (channelId === chatChannelId) {
                channelType = 'chat';
            } else if (channelId === staffChannelId) {
                channelType = 'staff';
            }

            // Clean and format message content
            const cleanContent = this.cleanMessageContent(message.content);

            const processedData = {
                type: 'discord_message',
                platform: 'discord',
                channelType: channelType,
                messageId: message.id,
                channelId: message.channel.id,
                channelName: message.channel.name,
                author: {
                    id: message.author.id,
                    username: message.author.username,
                    displayName: message.author.displayName || message.author.username,
                    discriminator: message.author.discriminator,
                    avatar: message.author.displayAvatarURL(),
                    bot: message.author.bot
                },
                content: cleanContent,
                originalContent: message.content,
                timestamp: message.createdTimestamp,
                mentions: {
                    users: message.mentions.users.map(u => ({
                        id: u.id,
                        username: u.username,
                        displayName: u.displayName || u.username
                    })),
                    channels: message.mentions.channels.map(c => ({
                        id: c.id,
                        name: c.name,
                        type: c.type
                    })),
                    roles: message.mentions.roles.map(r => ({
                        id: r.id,
                        name: r.name,
                        color: r.hexColor
                    }))
                },
                attachments: message.attachments.map(a => ({
                    id: a.id,
                    name: a.name,
                    url: a.url,
                    size: a.size,
                    contentType: a.contentType
                })),
                embeds: message.embeds.length > 0 ? message.embeds : null,
                reference: message.reference ? {
                    messageId: message.reference.messageId,
                    channelId: message.reference.channelId,
                    guildId: message.reference.guildId
                } : null
            };

            return processedData;

        } catch (error) {
            logger.logError(error, 'Error processing Discord message');
            return null;
        }
    }

    /**
     * Clean message content for Minecraft
     * @param {string} content - Raw message content
     * @returns {string} Cleaned content
     */
    cleanMessageContent(content) {
        if (!content) return '';

        let cleaned = content;

        // Remove Discord formatting that doesn't translate well to Minecraft
        cleaned = cleaned.replace(/```[\s\S]*?```/g, '[code block]'); // Code blocks
        cleaned = cleaned.replace(/`([^`]+)`/g, '$1'); // Inline code
        cleaned = cleaned.replace(/\*\*([^*]+)\*\*/g, '$1'); // Bold
        cleaned = cleaned.replace(/\*([^*]+)\*/g, '$1'); // Italic
        cleaned = cleaned.replace(/~~([^~]+)~~/g, '$1'); // Strikethrough
        cleaned = cleaned.replace(/__([^_]+)__/g, '$1'); // Underline
        cleaned = cleaned.replace(/\|\|([^|]+)\|\|/g, '[spoiler]'); // Spoilers

        // Convert mentions to readable format
        cleaned = cleaned.replace(/<@!?(\d+)>/g, '@user'); // User mentions
        cleaned = cleaned.replace(/<#(\d+)>/g, '#channel'); // Channel mentions
        cleaned = cleaned.replace(/<@&(\d+)>/g, '@role'); // Role mentions

        // Convert custom emojis to names
        cleaned = cleaned.replace(/<a?:(\w+):\d+>/g, ':$1:');

        // Remove excessive whitespace and trim
        cleaned = cleaned.replace(/\s+/g, ' ').trim();

        // Limit length for Minecraft chat
        const maxLength = 200;
        if (cleaned.length > maxLength) {
            cleaned = cleaned.substring(0, maxLength - 3) + '...';
        }

        return cleaned;
    }

    // ==================== UTILITY METHODS ====================

    /**
     * Add bot user to ignore list
     * @param {string} userId - User ID to ignore
     */
    addBotUser(userId) {
        this.botUsers.add(userId);
        logger.debug(`Added bot user to ignore list: ${userId}`);
    }

    /**
     * Remove bot user from ignore list
     * @param {string} userId - User ID to remove
     */
    removeBotUser(userId) {
        this.botUsers.delete(userId);
        logger.debug(`Removed bot user from ignore list: ${userId}`);
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
     * Check if channel is monitored
     * @param {string} channelId - Channel ID
     * @returns {boolean} Whether channel is monitored
     */
    isMonitoredChannel(channelId) {
        return channelId === this.channels.chat?.id || channelId === this.channels.staff?.id;
    }

    /**
     * Get statistics
     * @returns {object} Handler statistics
     */
    getStatistics() {
        return {
            ...this.stats,
            botUsersIgnored: this.botUsers.size,
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
            commandPrefix: this.commandPrefix,
            clientReady: !!this.client
        };
    }

    /**
     * Update configuration
     * @param {object} newConfig - New configuration
     */
    updateConfig(newConfig) {
        // Update command prefix
        if (newConfig.commandPrefix !== undefined) {
            this.commandPrefix = newConfig.commandPrefix;
        }

        // Update message formatter config
        if (this.messageFormatter && newConfig.messageFormatter) {
            this.messageFormatter.updateConfig(newConfig.messageFormatter);
        }

        logger.debug('MessageHandler configuration updated');
    }

    /**
     * Cleanup resources
     */
    cleanup() {
        this.botUsers.clear();
        this.client = null;
        this.channels = { chat: null, staff: null };

        // Remove all listeners
        this.removeAllListeners();

        logger.debug('MessageHandler cleaned up');
    }
}

module.exports = MessageHandler;