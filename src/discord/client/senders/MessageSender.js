/**
 * Message Sender - Discord Message Delivery System
 * 
 * This file handles sending messages from Minecraft to Discord channels. It manages
 * message formatting, delivery through webhooks or regular channels, rate limiting,
 * and provides specialized methods for different message types (guild messages, events,
 * system messages, connection status).
 * 
 * The sender provides:
 * - Guild chat message delivery to Discord
 * - Event message delivery (joins, leaves, promotions, etc.)
 * - System message delivery for bot notifications
 * - Connection status updates with embeds
 * - Webhook integration for immersive messaging
 * - Regular channel fallback when webhooks unavailable
 * - Rate limiting to prevent Discord API abuse
 * - Channel validation and caching
 * - Message formatting through MessageFormatter
 * - Embed creation through EmbedBuilder
 * 
 * Message Types:
 * - Guild Messages: Regular chat and officer chat from guilds
 * - Events: Player joins, leaves, promotions, demotes, kicks
 * - System: Bot notifications and status updates
 * - Connection Status: Bot connection state changes with rich embeds
 * 
 * Delivery Methods:
 * - Webhook: Messages appear with custom usernames and avatars
 * - Channel: Standard bot messages with optional embeds
 * - Automatic fallback from webhook to channel if webhook unavailable
 * 
 * Rate Limiting:
 * - Configurable message limit per time window
 * - Per-channel rate limiting tracking
 * - Automatic cleanup of old timestamps
 * - Protection against Discord API rate limits
 * 
 * Channel Routing:
 * - Chat channel: Regular guild messages, events, connection status
 * - Staff channel: Officer chat messages, admin notifications
 * 
 * @author Fabien83560
 * @version 1.0.0
 * @license ISC
 */

// Globals Imports
const { EmbedBuilder: DiscordEmbedBuilder } = require('discord.js');

// Specific Imports
const BridgeLocator = require("../../../bridgeLocator.js");
const MessageFormatter = require("../../../shared/MessageFormatter.js");
const WebhookSender = require("./WebhookSender.js");
const EmbedBuilder = require("../../utils/EmbedBuilder.js");
const BotStatusPanel = require("../BotStatusPanel.js");
const logger = require("../../../shared/logger");
const metrics = require("../../../shared/BridgeMetrics.js");

/**
 * MessageSender - Manages message delivery to Discord
 * 
 * Handles all outgoing messages from the bridge to Discord, including
 * formatting, channel routing, rate limiting, and delivery method selection.
 * 
 * @class
 */
class MessageSender {
    /**
     * Create a new MessageSender instance
     * Initializes configuration, components, and rate limiting system
     */
    constructor() {
        const mainBridge = BridgeLocator.getInstance();
        this.config = mainBridge.config;

        this.client = null;
        this.messageFormatter = null;
        this.webhookSender = null;
        this.embedBuilder = null;

        this.channels = {
            chat: null,
            staff: null,
            statusLog: null
        };

        this.botStatusPanel = null;

        // Rate limiting
        this.rateLimiter = new Map(); // channelId -> last message times
        this.rateLimit = this.config.get('bridge.rateLimit.discord') || { limit: 5, window: 10000 };

        // Serializes slot acquisition per channel. Without this, every concurrent
        // sender evaluated isRateLimited() before any of them called updateRateLimit(),
        // so the limiter under-counted badly - and when it did trigger it discarded the
        // message outright. Callers now queue behind each other and wait for a slot.
        this._slotChains = new Map(); // channelId -> tail promise
        this._pendingPerChannel = new Map(); // channelId -> waiting sender count
        this.maxPendingPerChannel = this.config.get('bridge.rateLimit.discordMaxPending') || 500;

        // Initialize only the components that don't require Discord client
        this.initializeComponents();
    }

    // ==================== INITIALIZATION ====================

    /**
     * Initialize components that don't require Discord client
     * 
     * Sets up message formatter, webhook sender (if enabled), and embed builder.
     * Called automatically in constructor before Discord client is available.
     * 
     * @private
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
     * 
     * Completes initialization with Discord client reference, validates channels,
     * and initializes webhook sender if enabled. Called after Discord client is ready.
     * 
     * @async
     * @param {Client} client - Discord client instance
     * @throws {Error} If client is not provided
     * @throws {Error} If channel validation fails
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

            // Initialize bot status panel in the status log channel (if configured)
            if (this.channels.statusLog) {
                this.botStatusPanel = new BotStatusPanel();
                await this.botStatusPanel.initialize(client, this.channels.statusLog);
            }

            logger.discord('MessageSender initialized with Discord client');

        } catch (error) {
            logger.logError(error, 'Failed to initialize MessageSender with client');
            throw error;
        }
    }

    /**
     * Validate and cache Discord channels
     * 
     * Fetches and validates chat and staff channels from Discord using
     * configured channel IDs. Caches channel references for efficient access.
     * 
     * @async
     * @private
     * @throws {Error} If client is not available
     * @throws {Error} If channel configuration is missing
     * @throws {Error} If channels cannot be fetched
     */
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

            // Load status log channel (optional)
            const statusChannelId = this.config.get('discord.logChannels.botStatus');
            if (statusChannelId) {
                const statusLogChannel = await this.client.channels.fetch(statusChannelId);
                if (statusLogChannel) {
                    this.channels.statusLog = statusLogChannel;
                    logger.discord(`Validated Discord channels - Chat: ${chatChannel.name}, Staff: ${staffChannel.name}, StatusLog: ${statusLogChannel.name}`);
                } else {
                    logger.warn(`Status log channel not found: ${statusChannelId}`);
                    logger.discord(`Validated Discord channels - Chat: ${chatChannel.name}, Staff: ${staffChannel.name}`);
                }
            } else {
                logger.discord(`Validated Discord channels - Chat: ${chatChannel.name}, Staff: ${staffChannel.name}`);
            }

        } catch (error) {
            logger.logError(error, 'Failed to validate Discord channels');
            throw error;
        }
    }

    // ==================== MAIN SENDING METHODS ====================

    /**
     * Send guild chat message to Discord
     * 
     * Routes guild messages to appropriate Discord channel (chat or staff based on
     * chat type). Uses webhooks when available, falls back to regular channel sending.
     * Applies rate limiting and message formatting.
     * 
     * @async
     * @param {object} messageData - Parsed guild message data
     * @param {string} messageData.chatType - Chat type ('guild' or 'officer')
     * @param {string} messageData.username - Player username
     * @param {string} messageData.message - Message content
     * @param {object} guildConfig - Guild configuration
     * @returns {Promise<Message|null>} Sent Discord message or null if rate limited
     * @throws {Error} If client is not initialized
     * @throws {Error} If channel is not available
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

            // Get formatted message
            const formattedMessage = this.messageFormatter.formatGuildMessage(messageData, guildConfig, guildConfig, 'messagesToDiscord');
            if (!formattedMessage) {
                metrics.dropped('mc_to_discord', 'format_failed', `${messageData.username}: ${messageData.message}`);
                return null;
            }

            // Wait for a slot instead of discarding the message when the channel is busy
            await this.acquireSendSlot(channel.id, 'mc_to_discord');

            let result;

            // Use webhook if available and preferred
            if (this.webhookSender && this.webhookSender.hasWebhook(channelType) &&
                this.config.get('bridge.webhook.useForGuildMessages') !== false) {

                result = await this.sendViaWebhook(messageData, guildConfig, channelType);
                metrics.sent('mc_to_discord', 'webhook');
            } else {
                // Send via regular channel
                result = await this.sendViaChannel(formattedMessage, channel);
                metrics.sent('mc_to_discord', 'channel');
            }

            logger.discord(`[DISCORD] Sent guild message to ${channelType} channel: "${formattedMessage}"`);

            return result;

        } catch (error) {
            logger.logError(error, 'Failed to send guild message to Discord');
            throw error;
        }
    }

    /**
     * Send event to Discord
     * 
     * Sends guild events (joins, leaves, promotions, demotes, kicks) to Discord
     * chat channel. Formats events using MessageFormatter and applies rate limiting.
     * 
     * @async
     * @param {object} eventData - Parsed event data
     * @param {string} eventData.type - Event type (join, leave, promote, demote, kick)
     * @param {string} eventData.username - Player username
     * @param {object} guildConfig - Guild configuration
     * @returns {Promise<Message|null>} Sent Discord message or null if rate limited
     * @throws {Error} If client is not initialized
     * @throws {Error} If chat channel is not available
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

            // Get formatted message
            const formattedMessage = this.messageFormatter.formatGuildEvent(eventData, guildConfig, guildConfig, 'messagesToDiscord');

            if (!formattedMessage || formattedMessage === "unknown_event_type") {
                // Non-bridgeable types (the /g online listing) are expected here and are
                // filtered, not lost. Anything else reaching this point is a real gap in
                // the templates and must be visible.
                const isExpected = MessageFormatter.NON_BRIDGEABLE_EVENTS.includes(eventData.type);

                if (isExpected) {
                    metrics.filtered('mc_to_discord', `non_bridgeable_${eventData.type}`);
                } else {
                    metrics.dropped(
                        'mc_to_discord',
                        `no_template_${eventData.type}`,
                        (eventData.raw || '').substring(0, 120)
                    );
                }

                return null;
            }

            // Wait for a slot instead of discarding the event when the channel is busy
            await this.acquireSendSlot(channel.id, 'mc_to_discord');

            // Send the message
            const result = await this.sendViaChannel(formattedMessage, channel);
            metrics.sent('mc_to_discord', `event_${eventData.type}`);

            logger.discord(`[DISCORD] Sent event to chat channel: "${formattedMessage}"`);

            return result;

        } catch (error) {
            logger.logError(error, 'Failed to send event to Discord');
            throw error;
        }
    }

    /**
     * Send system message to Discord
     * 
     * Sends system notifications (bot status, errors, info) to specified Discord channel.
     * Used for bridge-level notifications and status updates.
     * 
     * @async
     * @param {string} type - System message type (status, error, info, etc.)
     * @param {object} data - Message data
     * @param {string} channelType - Target channel type ('chat' or 'staff')
     * @returns {Promise<Message|null>} Sent Discord message or null if rate limited
     * @throws {Error} If client is not initialized
     * @throws {Error} If target channel is not available
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

            // Get formatted system message
            const formattedMessage = this.messageFormatter.formatSystem(type, data, 'discord');

            if (!formattedMessage) {
                metrics.dropped('mc_to_discord', `no_system_template_${type}`);
                return null;
            }

            // Wait for a slot instead of discarding the notification
            await this.acquireSendSlot(channel.id, 'mc_to_discord');

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
     * 
     * Sends bot connection status updates with rich embeds showing connection state,
     * guild information, and additional details. Supports connected, disconnected,
     * reconnecting, and error states.
     * 
     * @async
     * @param {string} status - Connection status ('connected', 'disconnected', 'reconnecting', 'error')
     * @param {object} guildConfig - Guild configuration
     * @param {string} guildConfig.name - Guild name for display
     * @param {object} details - Additional status details
     * @param {string} details.reason - Disconnection reason (optional)
     * @param {string} details.error - Error message (optional)
     * @returns {Promise<Message>} Sent Discord message with embed
     * @throws {Error} If client is not initialized
     * @throws {Error} If chat channel is not available
     */
    async sendConnectionStatus(status, guildConfig, details = {}) {
        if (!this.client) {
            throw new Error('Discord client not initialized');
        }

        try {
            // Update the bot status panel (if initialized) — panel is the primary UI
            if (this.botStatusPanel) {
                this.botStatusPanel.onConnectionEvent(guildConfig.id, status, details);
                logger.discord(`[DISCORD] Bot status panel updated: ${guildConfig.name} → ${status}`);
                return;
            }

            // Fallback: send a plain message when no panel is available
            const channel = this.channels.statusLog || this.channels.chat;
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

                case 'disconnected': {
                    const reason = details.reason ? ` (${details.reason})` : '';
                    message = `❌ **${guildConfig.name}** bot disconnected from Hypixel${reason}`;
                    embed = this.embedBuilder.createConnectionEmbed(guildConfig, status, details);
                    break;
                }

                case 'reconnecting':
                    message = `🔄 **${guildConfig.name}** bot reconnecting to Hypixel...`;
                    break;

                case 'reconnected':
                    message = `🔄 **${guildConfig.name}** bot reconnected to Hypixel`;
                    embed = this.embedBuilder.createConnectionEmbed(guildConfig, status, details);
                    break;

                case 'error': {
                    const errorMsg = details.error ? ` - ${details.error}` : '';
                    message = `⚠️ **${guildConfig.name}** connection error${errorMsg}`;
                    embed = this.embedBuilder.createConnectionEmbed(guildConfig, status, details);
                    break;
                }

                case 'manual_disconnect':
                    message = `🔌 **${guildConfig.name}** bot manually disconnected`;
                    break;

                case 'manual_reconnect':
                    message = `🔄 **${guildConfig.name}** bot manually reconnected to Hypixel`;
                    embed = this.embedBuilder.createConnectionEmbed(guildConfig, 'connected', details);
                    break;

                default:
                    message = `ℹ️ **${guildConfig.name}** status: ${status}`;
            }

            const result = await this.sendViaChannel(message, channel, embed);
            logger.discord(`[DISCORD] Sent connection status: "${message}"`);
            return result;

        } catch (error) {
            logger.logError(error, 'Failed to send connection status to Discord');
            throw error;
        }
    }

    // ==================== INTERNAL SENDING METHODS ====================

    /**
     * Send message via webhook
     * 
     * Internal method to send messages through webhook system for immersive
     * messaging with custom usernames and avatars.
     * 
     * @async
     * @private
     * @param {object} messageData - Message data
     * @param {object} guildConfig - Guild configuration
     * @param {string} channelType - Channel type ('chat' or 'staff')
     * @returns {Promise<Message>} Sent webhook message
     * @throws {Error} If webhook sender is not available
     * @throws {Error} If webhook is not configured for channel
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
     * 
     * Internal method to send messages through regular Discord channel as bot.
     * Supports optional embed attachments.
     * 
     * @async
     * @private
     * @param {string} content - Message content
     * @param {Channel} channel - Discord channel
     * @param {EmbedBuilder|null} embed - Optional embed object
     * @returns {Promise<Message>} Sent channel message
     */
    async sendViaChannel(content, channel, embed = null) {
        const options = { content };

        if (embed) {
            options.embeds = [embed];
        }

        return await channel.send(options);
    }

    // ==================== RATE LIMITING ====================

    /**
     * Wait until the channel has a free rate-limit slot, then claim it
     *
     * Replaces the previous check-and-drop behaviour. Callers are chained per channel so
     * exactly one evaluates the limit at a time, which both removes the check-then-await
     * race and guarantees a message is delayed rather than discarded when the channel is
     * busy.
     *
     * A message is only refused when the backlog for a channel exceeds
     * maxPendingPerChannel, which means Discord has been unreachable long enough that
     * queueing further messages would just grow memory. That case is accounted as a
     * real drop.
     *
     * @async
     * @param {string} channelId - Channel to acquire a send slot on
     * @param {string} [direction='mc_to_discord'] - Metrics direction for accounting
     * @returns {Promise<void>} Resolves once a slot is claimed
     * @throws {Error} If the channel backlog is over the limit
     *
     * @example
     * await sender.acquireSendSlot(channel.id);
     * await channel.send(payload);
     */
    async acquireSendSlot(channelId, direction = 'mc_to_discord') {
        const pending = this._pendingPerChannel.get(channelId) || 0;

        if (pending >= this.maxPendingPerChannel) {
            metrics.dropped(direction, 'discord_backlog_full', `channel ${channelId}, ${pending} waiting`);
            throw new Error(`Discord send backlog full for channel ${channelId} (${pending} waiting)`);
        }

        this._pendingPerChannel.set(channelId, pending + 1);

        const previous = this._slotChains.get(channelId) || Promise.resolve();

        const current = previous.then(async () => {
            // Wait out the window rather than dropping the message
            while (this.isRateLimited(channelId)) {
                await this.wait(this.timeUntilSlotFree(channelId));
            }

            this.updateRateLimit(channelId);
        });

        // Keep the chain alive even if one waiter throws
        this._slotChains.set(channelId, current.catch(() => {}));

        try {
            await current;
        } finally {
            this._pendingPerChannel.set(channelId, (this._pendingPerChannel.get(channelId) || 1) - 1);
        }
    }

    /**
     * Compute how long until the channel's oldest send falls out of the window
     *
     * @param {string} channelId - Channel ID to check
     * @returns {number} Milliseconds to wait, minimum 50ms to avoid a busy loop
     *
     * @example
     * const delay = sender.timeUntilSlotFree(channel.id);
     */
    timeUntilSlotFree(channelId) {
        const times = this.rateLimiter.get(channelId) || [];

        if (times.length === 0) {
            return 50;
        }

        const oldest = Math.min(...times);
        const remaining = this.rateLimit.window - (Date.now() - oldest);

        return Math.max(50, remaining);
    }

    /**
     * Wait for a number of milliseconds
     *
     * @param {number} ms - Milliseconds to wait
     * @returns {Promise<void>}
     */
    wait(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    /**
     * Check if channel is rate limited
     *
     * Determines if the channel has exceeded the configured message rate limit.
     * Automatically cleans up old timestamps outside the rate limit window.
     *
     * @param {string} channelId - Channel ID to check
     * @returns {boolean} True if channel is rate limited
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
     * 
     * Records the current message timestamp for rate limiting tracking.
     * Automatically cleans up old timestamps outside the rate limit window.
     * 
     * @param {string} channelId - Channel ID to update
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

    // ==================== UTILITY METHODS ====================

    /**
     * Get channel by type
     * 
     * Returns the cached Discord channel reference for the specified type.
     * 
     * @param {string} channelType - Channel type ('chat' or 'staff')
     * @returns {Channel|null} Discord channel or null if not found
     */
    getChannel(channelType) {
        return this.channels[channelType] || null;
    }

    /**
     * Clear rate limiter
     * 
     * Clears all rate limiting data. Useful for testing or resetting state.
     */
    clearRateLimit() {
        this.rateLimiter.clear();
        logger.debug('Discord MessageSender rate limiter cleared');
    }

    /**
     * Update configuration
     * 
     * Updates sender configuration, particularly message formatter settings
     * for tag display and source tag visibility.
     * 
     * @param {object} newConfig - New configuration
     * @param {boolean} newConfig.showTags - Show guild tags (optional)
     * @param {boolean} newConfig.showSourceTag - Show source tag (optional)
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

    // ==================== CLEANUP ====================

    /**
     * Cleanup resources
     * 
     * Clears rate limiter, cleans up webhook sender, and releases channel references.
     * Should be called before disposing of the sender instance.
     */
    cleanup() {
        this.rateLimiter.clear();

        if (this.webhookSender) {
            this.webhookSender.cleanup();
        }

        if (this.botStatusPanel) {
            this.botStatusPanel.cleanup();
            this.botStatusPanel = null;
        }

        this.client = null;
        this.channels = { chat: null, staff: null, statusLog: null };

        logger.debug('Discord MessageSender cleaned up');
    }
}

module.exports = MessageSender;