// Specific Imports
const logger = require('./logger');
const MessageFormatter = require('./MessageFormatter.js');
const BridgeLocator = require('../bridgeLocator.js');

class InterGuildManager {
    constructor() {
        const mainBridge = BridgeLocator.getInstance();
        this.config = mainBridge.config;

        this.interGuildConfig = this.config.get('bridge.interGuild');
        this.messageFormatter = null;

        // Rate limiting
        this.rateLimiter = new Map(); // guildId -> last message times
        this.rateLimit = this.config.get('bridge.rateLimit.interGuild') || { limit: 2, window: 10000 };

        // Message queue for reliability
        this.messageQueue = [];
        this.isProcessingQueue = false;

        // Statistics
        this.stats = {
            messagesProcessed: 0,
            eventsProcessed: 0,
            messagesDropped: 0,
            rateLimitHits: 0,
            errors: 0
        };

        this.initialize();
    }

    async initialize() {
        try {
            // Initialize message formatter
            const formatterConfig = {
                showTags: this.interGuildConfig.showTags || false,
                showSourceTag: this.interGuildConfig.showSourceTag !== false, // true by default
                enableDebugLogging: this.config.get('features.messageSystem.enableDebugLogging') || false,
                maxMessageLength: this.config.get('advanced.messageCleaner.maxLength') || 256,
                fallbackToBasic: true
            };

            this.messageFormatter = new MessageFormatter(formatterConfig);

            // Start message queue processor
            if (this.interGuildConfig.enabled) {
                this.startQueueProcessor();
                logger.info('✅ InterGuildManager initialized and enabled');
            } else {
                logger.info('🔒 InterGuildManager initialized but disabled');
            }

        } catch (error) {
            logger.logError(error, 'Failed to initialize InterGuildManager');
            throw error;
        }
    }

    /**
     * Process a guild message for inter-guild transfer
     * @param {object} messageData - Parsed message data
     * @param {object} sourceGuildConfig - Source guild configuration
     * @param {object} minecraftManager - Minecraft manager instance for sending messages
     */
    async processGuildMessage(messageData, sourceGuildConfig, minecraftManager) {
        if (!this.interGuildConfig.enabled) {
            return;
        }

        // Skip if it's an officer message and officer-to-guild is disabled
        if (messageData.chatType === 'officer' && !this.interGuildConfig.officerToGuildChat) {
            logger.debug(`[${sourceGuildConfig.name}] Officer message skipped (officer-to-guild disabled)`);
            return;
        }

        try {
            // Get all enabled guilds except the source
            const allGuilds = this.config.getEnabledGuilds();
            const targetGuilds = allGuilds.filter(guild => guild.id !== sourceGuildConfig.id);

            if (targetGuilds.length === 0) {
                logger.debug('No target guilds found for inter-guild message');
                return;
            }

            // Check rate limiting
            if (this.isRateLimited(sourceGuildConfig.id)) {
                this.stats.rateLimitHits++;
                logger.debug(`[${sourceGuildConfig.name}] Message rate limited`);
                return;
            }

            logger.bridge(`[INTER-GUILD] Processing message from ${sourceGuildConfig.name} to ${targetGuilds.length} target guilds`);

            // Process each target guild
            for (const targetGuildConfig of targetGuilds) {
                await this.sendMessageToGuild(
                    messageData, 
                    sourceGuildConfig, 
                    targetGuildConfig, 
                    minecraftManager
                );
            }

            // Update rate limiting
            this.updateRateLimit(sourceGuildConfig.id);
            this.stats.messagesProcessed++;

        } catch (error) {
            logger.logError(error, `Error processing inter-guild message from ${sourceGuildConfig.name}`);
            this.stats.errors++;
        }
    }

    /**
     * Process a guild event for inter-guild transfer
     * @param {object} eventData - Parsed event data
     * @param {object} sourceGuildConfig - Source guild configuration
     * @param {object} minecraftManager - Minecraft manager instance for sending messages
     */
    async processGuildEvent(eventData, sourceGuildConfig, minecraftManager) {
        if (!this.interGuildConfig.enabled) {
            return;
        }

        // Check if this event type should be shared
        if (!this.shouldShareEvent(eventData.type)) {
            logger.debug(`[${sourceGuildConfig.name}] Event ${eventData.type} not configured for sharing`);
            return;
        }

        try {
            // Get all enabled guilds except the source
            const allGuilds = this.config.getEnabledGuilds();
            const targetGuilds = allGuilds.filter(guild => guild.id !== sourceGuildConfig.id);

            if (targetGuilds.length === 0) {
                logger.debug('No target guilds found for inter-guild event');
                return;
            }

            logger.bridge(`[INTER-GUILD] Processing event ${eventData.type} from ${sourceGuildConfig.name} to ${targetGuilds.length} target guilds`);

            // Process each target guild
            for (const targetGuildConfig of targetGuilds) {
                await this.sendEventToGuild(
                    eventData, 
                    sourceGuildConfig, 
                    targetGuildConfig, 
                    minecraftManager
                );
            }

            this.stats.eventsProcessed++;

        } catch (error) {
            logger.logError(error, `Error processing inter-guild event from ${sourceGuildConfig.name}`);
            this.stats.errors++;
        }
    }

    /**
     * Send a formatted message to a specific guild
     * @param {object} messageData - Message data
     * @param {object} sourceGuildConfig - Source guild config
     * @param {object} targetGuildConfig - Target guild config
     * @param {object} minecraftManager - Minecraft manager instance
     */
    async sendMessageToGuild(messageData, sourceGuildConfig, targetGuildConfig, minecraftManager) {
        try {
            // Format message for target guild
            const formattedMessage = this.messageFormatter.formatGuildMessage(
                messageData,
                sourceGuildConfig,
                targetGuildConfig,
                'messagesToMinecraft'
            );

            if (!formattedMessage) {
                logger.warn(`[${targetGuildConfig.name}] No formatted message generated`);
                return;
            }

            // Queue the message for reliable delivery
            this.queueMessage({
                type: 'message',
                guildId: targetGuildConfig.id,
                message: formattedMessage,
                sourceGuild: sourceGuildConfig.name,
                targetGuild: targetGuildConfig.name,
                timestamp: Date.now(),
                attempts: 0,
                maxAttempts: 3
            }, minecraftManager);

            logger.bridge(`[INTER-GUILD] Queued message for ${targetGuildConfig.name}: "${formattedMessage}"`);

        } catch (error) {
            logger.logError(error, `Error sending message to guild ${targetGuildConfig.name}`);
        }
    }

    /**
     * Send a formatted event to a specific guild
     * @param {object} eventData - Event data
     * @param {object} sourceGuildConfig - Source guild config
     * @param {object} targetGuildConfig - Target guild config
     * @param {object} minecraftManager - Minecraft manager instance
     */
    async sendEventToGuild(eventData, sourceGuildConfig, targetGuildConfig, minecraftManager) {
        try {
            // Format event for target guild
            const formattedMessage = this.messageFormatter.formatGuildEvent(
                eventData,
                sourceGuildConfig,
                targetGuildConfig,
                'messagesToMinecraft'
            );

            if (!formattedMessage) {
                logger.warn(`[${targetGuildConfig.name}] No formatted event generated for ${eventData.type}`);
                return;
            }

            // Queue the event message for reliable delivery
            this.queueMessage({
                type: 'event',
                guildId: targetGuildConfig.id,
                message: formattedMessage,
                sourceGuild: sourceGuildConfig.name,
                targetGuild: targetGuildConfig.name,
                eventType: eventData.type,
                timestamp: Date.now(),
                attempts: 0,
                maxAttempts: 3
            }, minecraftManager);

            logger.bridge(`[INTER-GUILD] Queued event for ${targetGuildConfig.name}: "${formattedMessage}"`);

        } catch (error) {
            logger.logError(error, `Error sending event to guild ${targetGuildConfig.name}`);
        }
    }

    /**
     * Queue a message for reliable delivery
     * @param {object} messageItem - Message item to queue
     * @param {object} minecraftManager - Minecraft manager instance
     */
    queueMessage(messageItem, minecraftManager) {
        messageItem.minecraftManager = minecraftManager;
        this.messageQueue.push(messageItem);

        logger.debug(`[INTER-GUILD] Message queued (queue size: ${this.messageQueue.length})`);
    }

    /**
     * Start the message queue processor
     */
    startQueueProcessor() {
        if (this.isProcessingQueue) {
            return;
        }

        this.isProcessingQueue = true;
        this.processQueue();
    }

    /**
     * Process the message queue
     */
    async processQueue() {
        while (this.isProcessingQueue) {
            try {
                if (this.messageQueue.length > 0) {
                    const messageItem = this.messageQueue.shift();
                    await this.deliverQueuedMessage(messageItem);
                }

                // Wait before processing next message
                await this.wait(1000); // 1 second between messages

            } catch (error) {
                logger.logError(error, 'Error in queue processor');
                await this.wait(5000); // Wait longer on error
            }
        }
    }

    /**
     * Deliver a queued message
     * @param {object} messageItem - Message item from queue
     */
    async deliverQueuedMessage(messageItem) {
        try {
            messageItem.attempts++;

            // Check if guild is connected
            if (!messageItem.minecraftManager.isGuildConnected(messageItem.guildId)) {
                if (messageItem.attempts < messageItem.maxAttempts) {
                    // Re-queue if guild is not connected and we have attempts left
                    logger.warn(`[${messageItem.targetGuild}] Not connected, re-queueing message (attempt ${messageItem.attempts}/${messageItem.maxAttempts})`);
                    setTimeout(() => {
                        this.messageQueue.push(messageItem);
                    }, 5000); // Try again in 5 seconds
                    return;
                } else {
                    logger.warn(`[${messageItem.targetGuild}] Max attempts reached, dropping message`);
                    this.stats.messagesDropped++;
                    return;
                }
            }

            // Send the message
            await messageItem.minecraftManager.sendMessage(messageItem.guildId, messageItem.message);
            
            logger.bridge(`[INTER-GUILD] Delivered ${messageItem.type} to ${messageItem.targetGuild}: "${messageItem.message}"`);

        } catch (error) {
            if (messageItem.attempts < messageItem.maxAttempts) {
                logger.warn(`[${messageItem.targetGuild}] Failed to deliver message (attempt ${messageItem.attempts}/${messageItem.maxAttempts}), re-queueing`);
                setTimeout(() => {
                    this.messageQueue.push(messageItem);
                }, 2000 * messageItem.attempts); // Exponential backoff
            } else {
                logger.logError(error, `[${messageItem.targetGuild}] Max attempts reached, dropping message`);
                this.stats.messagesDropped++;
            }
        }
    }

    /**
     * Check if a guild is rate limited
     * @param {string} guildId - Guild ID to check
     * @returns {boolean} Whether guild is rate limited
     */
    isRateLimited(guildId) {
        if (!this.rateLimit || this.rateLimit.limit <= 0) {
            return false; // Rate limiting disabled
        }

        const now = Date.now();
        const guildTimes = this.rateLimiter.get(guildId) || [];

        // Remove old timestamps outside the window
        const validTimes = guildTimes.filter(time => now - time < this.rateLimit.window);

        // Check if we've exceeded the limit
        return validTimes.length >= this.rateLimit.limit;
    }

    /**
     * Update rate limiting for a guild
     * @param {string} guildId - Guild ID
     */
    updateRateLimit(guildId) {
        if (!this.rateLimit || this.rateLimit.limit <= 0) {
            return; // Rate limiting disabled
        }

        const now = Date.now();
        const guildTimes = this.rateLimiter.get(guildId) || [];

        // Add current time
        guildTimes.push(now);

        // Remove old timestamps
        const validTimes = guildTimes.filter(time => now - time < this.rateLimit.window);

        this.rateLimiter.set(guildId, validTimes);
    }

    /**
     * Check if an event type should be shared between guilds
     * @param {string} eventType - Event type
     * @returns {boolean} Whether event should be shared
     */
    shouldShareEvent(eventType) {
        const shareableEvents = this.interGuildConfig.shareableEvents || [
            'join', 'leave', 'kick', 'promote', 'demote', 'level', 'motd'
        ];

        return shareableEvents.includes(eventType);
    }

    /**
     * Stop the queue processor
     */
    stopQueueProcessor() {
        this.isProcessingQueue = false;
    }

    /**
     * Update configuration
     * @param {object} newConfig - New configuration
     */
    updateConfig(newConfig) {
        this.interGuildConfig = { ...this.interGuildConfig, ...newConfig };
        
        // Update message formatter config
        if (this.messageFormatter) {
            this.messageFormatter.updateConfig({
                showTags: this.interGuildConfig.showTags,
                showSourceTag: this.interGuildConfig.showSourceTag
            });
        }

        logger.debug('InterGuildManager configuration updated');
    }

    /**
     * Get current statistics
     * @returns {object} Current statistics
     */
    getStatistics() {
        return {
            ...this.stats,
            queueSize: this.messageQueue.length,
            rateLimiterSize: this.rateLimiter.size,
            isProcessingQueue: this.isProcessingQueue,
            config: {
                enabled: this.interGuildConfig.enabled,
                officerToGuildChat: this.interGuildConfig.officerToGuildChat,
                showTags: this.interGuildConfig.showTags,
                showSourceTag: this.interGuildConfig.showSourceTag
            }
        };
    }

    /**
     * Clear rate limiter
     */
    clearRateLimit() {
        this.rateLimiter.clear();
        logger.debug('InterGuildManager rate limiter cleared');
    }

    /**
     * Clear message queue
     */
    clearQueue() {
        this.messageQueue.length = 0;
        logger.debug('InterGuildManager message queue cleared');
    }

    /**
     * Test message formatting
     * @param {object} testData - Test data
     * @returns {object} Test results
     */
    testMessageFormatting(testData) {
        if (!this.messageFormatter) {
            return { error: 'MessageFormatter not initialized' };
        }

        return this.messageFormatter.testFormatting(
            'messagesToMinecraft',
            'Hypixel',
            'guild',
            testData
        );
    }

    /**
     * Wait utility function
     * @param {number} ms - Milliseconds to wait
     * @returns {Promise} Promise that resolves after the delay
     */
    wait(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
}

module.exports = InterGuildManager;