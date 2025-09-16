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

        this.messageHashes = new Map(); // hash -> { timestamp, count, guilds }
        this.duplicateDetectionWindow = 30000; // 30 seconds
        this.maxDuplicatesPerWindow = 2; // Maximum 2 identical messages per window
        this.messageHistory = new Map(); // guildId -> recent messages
        this.historySize = 10; // Keep last 10 messages per guild

        // Statistics
        this.stats = {
            messagesProcessed: 0,
            officerMessagesProcessed: 0,
            eventsProcessed: 0,
            messagesDropped: 0,
            rateLimitHits: 0,
            duplicatesDropped: 0,
            loopsDetected: 0,
            errors: 0,
            sameGuildPrevented: 0
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
                logger.info('✅ InterGuildManager initialized and enabled with officer chat support');
            } else {
                logger.info('🔒 InterGuildManager initialized but disabled');
            }

            // Start cleanup interval for anti-loop protection
            this.startCleanupInterval();

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

        try {
            if (this.isMessageLoopOrDuplicate(messageData, sourceGuildConfig)) {
                this.stats.loopsDetected++;
                return;
            }

            // Handle officer messages specifically
            if (messageData.chatType === 'officer') {
                // Process officer-to-officer chat if enabled
                if (this.interGuildConfig.officerToOfficerChat) {
                    await this.processOfficerMessage(messageData, sourceGuildConfig, minecraftManager);
                }
                
                // Also process officer-to-guild chat if enabled
                if (this.interGuildConfig.officerToGuildChat) {
                    // Continue processing as regular guild message below
                } else {
                    // Skip regular guild processing if officer-to-guild is disabled
                    logger.debug(`[${sourceGuildConfig.name}] Officer message processed for officer-to-officer only`);
                    return;
                }
            }

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

            const messageType = messageData.chatType === 'officer' ? 'guild message (from officer chat)' : 'guild message';
            logger.bridge(`[INTER-GUILD] Processing ${messageType} from ${sourceGuildConfig.name} to ${targetGuilds.length} target guilds`);

            this.trackMessage(messageData, sourceGuildConfig);

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
     * Process officer messages for inter-guild transfer
     * @param {object} messageData - Parsed officer message data
     * @param {object} sourceGuildConfig - Source guild configuration
     * @param {object} minecraftManager - Minecraft manager instance for sending messages
     */
    async processOfficerMessage(messageData, sourceGuildConfig, minecraftManager) {
        // Check if officer-to-officer chat is enabled
        if (!this.interGuildConfig.officerToOfficerChat) {
            logger.debug(`[${sourceGuildConfig.name}] Officer-to-officer chat disabled, skipping officer message`);
            return;
        }

        try {
            // Get all enabled guilds except the source
            const allGuilds = this.config.getEnabledGuilds();
            const targetGuilds = allGuilds.filter(guild => guild.id !== sourceGuildConfig.id);

            if (targetGuilds.length === 0) {
                logger.debug('No target guilds found for inter-guild officer message');
                return;
            }

            // Check rate limiting
            if (this.isRateLimited(sourceGuildConfig.id)) {
                this.stats.rateLimitHits++;
                logger.debug(`[${sourceGuildConfig.name}] Officer message rate limited`);
                return;
            }

            logger.bridge(`[INTER-GUILD] Processing officer message from ${sourceGuildConfig.name} to ${targetGuilds.length} target guilds`);

            this.trackMessage(messageData, sourceGuildConfig);

            // Process each target guild for officer messages
            for (const targetGuildConfig of targetGuilds) {
                await this.sendOfficerMessageToGuild(
                    messageData, 
                    sourceGuildConfig, 
                    targetGuildConfig, 
                    minecraftManager
                );
            }

            // Update rate limiting
            this.updateRateLimit(sourceGuildConfig.id);
            this.stats.officerMessagesProcessed++;

        } catch (error) {
            logger.logError(error, `Error processing inter-guild officer message from ${sourceGuildConfig.name}`);
            this.stats.errors++;
        }
    }

    /**
     * Check if message is a loop or duplicate (with officer chat support)
     * @param {object} messageData - Message data
     * @param {object} sourceGuildConfig - Source guild configuration
     * @returns {boolean} Whether message should be dropped as loop/duplicate
     */
    isMessageLoopOrDuplicate(messageData, sourceGuildConfig) {
        if (!messageData.message || !messageData.username) {
            return false;
        }

        const message = messageData.message.trim();
        const username = messageData.username;
        const chatType = messageData.chatType || 'guild';
        const botUsername = sourceGuildConfig.account.username;

        // CRITICAL: Always filter our own bot messages first
        if (username.toLowerCase() === botUsername.toLowerCase()) {
            logger.debug(`[${sourceGuildConfig.name}] ✅ FILTERED own bot ${chatType} message: ${username} -> "${message.substring(0, 50)}..."`);
            return true;
        }

        // Pattern 1 - Check for obvious relay patterns
        const relayPatterns = [
            /^(\w+):\s*(.+)$/,                    // "User: message"
            /^(\w+):\s*\1:\s*(.+)$/,             // "User: User: message"
            /^(\w+):\s*(\w+):\s*(.+)$/,          // "User1: User2: message"
            /^\[[\w\d]+\]\s+(\w+):\s*(.+)$/,     // "[TAG] User: message"
            /^\[[\w\d]+\]\s+(\w+)\s+\[.*?\]:\s*(.+)$/,  // "[TAG] User [Rank]: message"
        ];

        // Officer-specific relay patterns
        if (chatType === 'officer') {
            relayPatterns.push(
                /^\[[\w\d]+\]\s+\[OFFICER\]\s+(\w+):\s*(.+)$/,     // "[TAG] [OFFICER] User: message"
                /^\[.*?\]\s+(\w+)\s+\[(?:Officer|Admin|Owner)\]:\s*(.+)$/i,  // "[TAG] User [Officer]: message"
            );
        }

        for (let i = 0; i < relayPatterns.length; i++) {
            const pattern = relayPatterns[i];
            if (pattern.test(message)) {
                logger.debug(`[${sourceGuildConfig.name}] ✅ FILTERED ${chatType} relay pattern ${i}: "${message.substring(0, 50)}..."`);
                return true;
            }
        }

        // Pattern 2 - Check message history for this guild
        const historyKey = `${sourceGuildConfig.id}-${chatType}`;
        const guildHistory = this.messageHistory.get(historyKey) || [];
        
        // Check if this exact message was sent recently
        const recentDuplicate = guildHistory.find(historyItem => 
            historyItem.message === message && 
            historyItem.username === username &&
            historyItem.chatType === chatType &&
            (Date.now() - historyItem.timestamp) < this.duplicateDetectionWindow
        );

        if (recentDuplicate) {
            logger.debug(`[${sourceGuildConfig.name}] ✅ FILTERED ${chatType} recent duplicate: ${username} -> "${message.substring(0, 30)}..."`);
            return true;
        }

        // Pattern 3 - Check for message hash duplicates across guilds
        const messageHash = this.generateMessageHash(message, username, chatType);
        const hashData = this.messageHashes.get(messageHash);

        if (hashData) {
            const timeSinceFirst = Date.now() - hashData.timestamp;
            
            if (timeSinceFirst < this.duplicateDetectionWindow) {
                hashData.count++;
                hashData.guilds.add(sourceGuildConfig.id);
                
                if (hashData.count > this.maxDuplicatesPerWindow) {
                    this.stats.duplicatesDropped++;
                    logger.debug(`[${sourceGuildConfig.name}] ✅ FILTERED ${chatType} hash duplicate (count: ${hashData.count}): "${message.substring(0, 30)}..."`);
                    return true;
                }
            }
        } else {
            // First time seeing this message hash
            this.messageHashes.set(messageHash, {
                timestamp: Date.now(),
                count: 1,
                guilds: new Set([sourceGuildConfig.id]),
                chatType: chatType
            });
        }

        return false;
    }

    /**
     * Track message for loop detection (with chat type support)
     * @param {object} messageData - Message data
     * @param {object} sourceGuildConfig - Source guild configuration
     */
    trackMessage(messageData, sourceGuildConfig) {
        const chatType = messageData.chatType || 'guild';
        const historyKey = `${sourceGuildConfig.id}-${chatType}`;
        const guildHistory = this.messageHistory.get(historyKey) || [];
        
        // Add current message to history
        guildHistory.push({
            message: messageData.message.trim(),
            username: messageData.username,
            chatType: chatType,
            timestamp: Date.now()
        });

        // Keep only recent messages
        if (guildHistory.length > this.historySize) {
            guildHistory.shift();
        }

        this.messageHistory.set(historyKey, guildHistory);
    }

    /**
     * Generate hash for message content (with chat type)
     * @param {string} message - Message content
     * @param {string} username - Username
     * @param {string} chatType - Chat type (guild/officer)
     * @returns {string} Message hash
     */
    generateMessageHash(message, username, chatType = 'guild') {
        // Simple hash combining username, message, and chat type
        const combined = `${chatType}:${username}:${message}`.toLowerCase();
        let hash = 0;
        
        for (let i = 0; i < combined.length; i++) {
            const char = combined.charCodeAt(i);
            hash = ((hash << 5) - hash) + char;
            hash = hash & hash; // Convert to 32-bit integer
        }
        
        return hash.toString();
    }

    /**
     * NEW: Start cleanup interval for anti-loop protection
     */
    startCleanupInterval() {
        setInterval(() => {
            this.cleanupAntiLoopData();
        }, 60000); // Clean up every minute
    }

    /**
     * NEW: Clean up old anti-loop data
     */
    cleanupAntiLoopData() {
        const now = Date.now();
        const cutoff = now - this.duplicateDetectionWindow;

        // Clean up message hashes
        for (const [hash, data] of this.messageHashes.entries()) {
            if (data.timestamp < cutoff) {
                this.messageHashes.delete(hash);
            }
        }

        // Clean up message history
        for (const [guildId, history] of this.messageHistory.entries()) {
            const filteredHistory = history.filter(item => item.timestamp > cutoff);
            if (filteredHistory.length > 0) {
                this.messageHistory.set(guildId, filteredHistory);
            } else {
                this.messageHistory.delete(guildId);
            }
        }

        logger.debug(`Anti-loop cleanup: ${this.messageHashes.size} hashes, ${this.messageHistory.size} guild histories`);
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

            // Process each target guild with additional verification
            for (const targetGuildConfig of targetGuilds) {
                // CRITICAL FIX: Double-check that we're not sending to the same guild
                if (this.isSameGuild(sourceGuildConfig, targetGuildConfig)) {
                    logger.warn(`[INTER-GUILD] PREVENTED: Attempted to send event ${eventData.type} from ${sourceGuildConfig.name} back to itself!`);
                    this.stats.sameGuildPrevented++;
                    continue;
                }

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
     * CRITICAL: Check if source and target guilds are the same
     * @param {object} sourceGuildConfig - Source guild configuration
     * @param {object} targetGuildConfig - Target guild configuration
     * @returns {boolean} Whether guilds are the same
     */
    isSameGuild(sourceGuildConfig, targetGuildConfig) {
        // Check multiple identifiers to be absolutely sure
        return sourceGuildConfig.id === targetGuildConfig.id ||
               sourceGuildConfig.name === targetGuildConfig.name ||
               (sourceGuildConfig.tag && targetGuildConfig.tag && sourceGuildConfig.tag === targetGuildConfig.tag);
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
            // CRITICAL FIX: Additional safety check to prevent sending to same guild
            if (this.isSameGuild(sourceGuildConfig, targetGuildConfig)) {
                logger.warn(`[INTER-GUILD] PREVENTED: Attempted to send message from ${sourceGuildConfig.name} back to itself!`);
                this.stats.sameGuildPrevented++;
                return;
            }

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
                sourceGuildId: sourceGuildConfig.id,
                targetGuildId: targetGuildConfig.id,
                timestamp: Date.now(),
                attempts: 0,
                maxAttempts: 3
            }, minecraftManager);

            logger.bridge(`[INTER-GUILD] Queued guild message for ${targetGuildConfig.name}: "${formattedMessage}"`);

        } catch (error) {
            logger.logError(error, `Error sending message to guild ${targetGuildConfig.name}`);
        }
    }

    /**
     * Send a formatted officer message to a specific guild
     * @param {object} messageData - Officer message data
     * @param {object} sourceGuildConfig - Source guild config
     * @param {object} targetGuildConfig - Target guild config
     * @param {object} minecraftManager - Minecraft manager instance
     */
    async sendOfficerMessageToGuild(messageData, sourceGuildConfig, targetGuildConfig, minecraftManager) {
        try {
            // CRITICAL FIX: Additional safety check to prevent sending to same guild
            if (this.isSameGuild(sourceGuildConfig, targetGuildConfig)) {
                logger.warn(`[INTER-GUILD] PREVENTED: Attempted to send officer message from ${sourceGuildConfig.name} back to itself!`);
                this.stats.sameGuildPrevented++;
                return;
            }

            // Format officer message for target guild
            const formattedMessage = this.messageFormatter.formatGuildMessage(
                messageData,
                sourceGuildConfig,
                targetGuildConfig,
                'messagesToMinecraft'
            );

            if (!formattedMessage) {
                logger.warn(`[${targetGuildConfig.name}] No formatted officer message generated`);
                return;
            }

            // Queue the officer message for reliable delivery
            this.queueMessage({
                type: 'officer_message',
                guildId: targetGuildConfig.id,
                message: formattedMessage,
                sourceGuild: sourceGuildConfig.name,
                targetGuild: targetGuildConfig.name,
                sourceGuildId: sourceGuildConfig.id,
                targetGuildId: targetGuildConfig.id,
                timestamp: Date.now(),
                attempts: 0,
                maxAttempts: 3
            }, minecraftManager);

            logger.bridge(`[INTER-GUILD] Queued officer message for ${targetGuildConfig.name}: "${formattedMessage}"`);

        } catch (error) {
            logger.logError(error, `Error sending officer message to guild ${targetGuildConfig.name}`);
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
            // CRITICAL FIX: Additional safety check to prevent sending to same guild
            if (this.isSameGuild(sourceGuildConfig, targetGuildConfig)) {
                logger.warn(`[INTER-GUILD] PREVENTED: Attempted to send event ${eventData.type} from ${sourceGuildConfig.name} back to itself!`);
                this.stats.sameGuildPrevented++;
                return;
            }

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
                sourceGuildId: sourceGuildConfig.id,
                targetGuildId: targetGuildConfig.id,
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

            // FINAL SAFETY CHECK: Ensure we're not about to send to the same guild
            if (messageItem.sourceGuildId && messageItem.targetGuildId && 
                messageItem.sourceGuildId === messageItem.targetGuildId) {
                logger.error(`[INTER-GUILD] FINAL BLOCK: Prevented sending ${messageItem.type} from ${messageItem.sourceGuild} to itself at delivery time!`);
                this.stats.sameGuildPrevented++;
                return;
            }

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

            // Send the message based on type
            if (messageItem.type === 'officer_message') {
                await messageItem.minecraftManager.sendOfficerMessage(messageItem.guildId, messageItem.message);
                logger.bridge(`[INTER-GUILD] Delivered officer message to ${messageItem.targetGuild}: "${messageItem.message}"`);
            } else {
                await messageItem.minecraftManager.sendMessage(messageItem.guildId, messageItem.message);
                logger.bridge(`[INTER-GUILD] Delivered ${messageItem.type} to ${messageItem.targetGuild}: "${messageItem.message}"`);
            }

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
            'welcome', 'disconnect', 'kick', 'promote', 'demote', 'level', 'motd'
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
            antiLoop: {
                messageHashes: this.messageHashes.size,
                guildHistories: this.messageHistory.size,
                duplicatesDropped: this.stats.duplicatesDropped,
                loopsDetected: this.stats.loopsDetected,
                sameGuildPrevented: this.stats.sameGuildPrevented
            },
            config: {
                enabled: this.interGuildConfig.enabled,
                officerToGuildChat: this.interGuildConfig.officerToGuildChat,
                officerToOfficerChat: this.interGuildConfig.officerToOfficerChat,
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
     * Clear anti-loop data
     */
    clearAntiLoopData() {
        this.messageHashes.clear();
        this.messageHistory.clear();
        logger.debug('InterGuildManager anti-loop data cleared');
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