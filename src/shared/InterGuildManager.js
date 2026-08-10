/**
 * Inter-Guild Manager - Cross-Guild Message and Event Broadcasting System
 * 
 * This class manages the broadcasting of messages and events between multiple Minecraft
 * guilds, creating a unified communication network. It handles message routing, anti-loop
 * protection, duplicate detection, rate limiting, and reliable delivery through a queue system.
 * 
 * The manager provides:
 * - Cross-guild message broadcasting (guild chat and officer chat)
 * - Guild event sharing between connected guilds
 * - Advanced anti-loop and duplicate detection system
 * - Rate limiting to prevent spam
 * - Reliable message delivery with queue and retry mechanism
 * - Officer-to-officer and officer-to-guild chat modes
 * - Discord integration for unified Minecraft-Discord communication
 * - Message history tracking for duplicate prevention
 * - Hash-based duplicate detection across guilds
 * - Automatic cleanup of stale tracking data
 * 
 * Anti-loop protection features:
 * - Bot message filtering (never relay own messages)
 * - Relay pattern detection (multiple regex patterns)
 * - Message history tracking (last 10 messages per guild)
 * - Hash-based duplicate detection (30-second window)
 * - Same-guild prevention (multiple verification checks)
 * 
 * Message flow:
 * 1. Message received from source guild
 * 2. Anti-loop/duplicate checks performed
 * 3. Rate limiting validation
 * 4. Message formatted for each target guild
 * 5. Messages queued for reliable delivery
 * 6. Queue processor delivers with retry logic
 * 7. Discord integration sends to Discord channels
 * 
 * Officer chat modes:
 * - officerToOfficerChat: Officer messages sent to other guilds' officer chats
 * - officerToGuildChat: Officer messages also sent to guild chats
 * 
 * Queue system features:
 * - Automatic retry with exponential backoff
 * - Maximum 3 delivery attempts per message
 * - Connection status checking before delivery
 * - 1 second delay between messages
 * 
 * @author Fabien83560
 * @version 1.0.0
 * @license ISC
 */

// Specific Imports
const logger = require('./logger');
const MessageFormatter = require('./MessageFormatter.js');
const BridgeLocator = require('../bridgeLocator.js');
const metrics = require('./BridgeMetrics.js');

/**
 * InterGuildManager - Manage cross-guild message and event broadcasting
 * 
 * Central manager class that handles all inter-guild communication including message
 * routing, event broadcasting, anti-loop protection, rate limiting, and reliable
 * delivery through a queue system.
 * 
 * @class
 */
class InterGuildManager {
    /**
     * Create a new InterGuildManager instance
     * 
     * Initializes the manager with configuration, message formatter, rate limiting,
     * anti-loop protection systems, and message queue. Sets up tracking systems for
     * duplicate detection and message history.
     * 
     * Configuration loaded:
     * - interGuildConfig: Inter-guild feature settings
     * - rateLimit: Rate limiting configuration (default: 2 messages per 10 seconds)
     * - shareableEvents: Events to share between guilds
     * - officerToOfficerChat: Officer chat routing setting
     * - officerToGuildChat: Officer to guild chat routing setting
     * 
     * Tracking systems initialized:
     * - messageHashes: Hash-based duplicate detection (30-second window)
     * - messageHistory: Recent message tracking (10 messages per guild)
     * - rateLimiter: Rate limit tracking per guild
     * - messageQueue: Reliable delivery queue
     */
    constructor() {
        const mainBridge = BridgeLocator.getInstance();
        this.config = mainBridge.config;

        this.interGuildConfig = this.config.get('bridge.interGuild');
        this.messageFormatter = null;
        
        // Discord integration
        this._discordManager = null;
        this._bridgeCoordinator = null;

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

        this.initialize();
    }

    /**
     * Initialize the inter-guild manager
     * 
     * Sets up the message formatter with configuration, starts the queue processor
     * if inter-guild features are enabled, initiates cleanup intervals for anti-loop
     * data, and establishes Discord integration.
     * 
     * Initialization steps:
     * 1. Create MessageFormatter with inter-guild config
     * 2. Start queue processor if enabled
     * 3. Start cleanup interval for anti-loop data
     * 4. Setup Discord integration
     * 
     * @async
     * @throws {Error} If initialization fails
     * 
     * @example
     * const manager = new InterGuildManager();
     * // Automatically calls initialize() in constructor
     */
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

            // Setup Discord integration
            this.setupDiscordIntegration();

        } catch (error) {
            logger.logError(error, 'Failed to initialize InterGuildManager');
            throw error;
        }
    }

    /**
     * Setup Discord integration
     * 
     * Establishes connection to Discord manager for unified Minecraft-Discord
     * communication. Allows inter-guild messages to also be sent to Discord channels.
     * 
     * @example
     * // Internal usage during initialization
     * this.setupDiscordIntegration();
     */
    setupDiscordIntegration() {
        try {
            const mainBridge = BridgeLocator.getInstance();
            this._discordManager = mainBridge.getDiscordManager?.();

            if (this._discordManager) {
                logger.bridge('✅ Discord integration setup completed for InterGuildManager');
            } else {
                logger.debug('Discord manager not available for InterGuildManager integration');
            }
            
        } catch (error) {
            logger.logError(error, 'Failed to setup Discord integration for InterGuildManager');
        }
    }

    /**
     * Set Discord manager reference
     * 
     * Updates the Discord manager reference. Called from main bridge when Discord
     * manager becomes available after initialization.
     * 
     * @param {object} discordManager - Discord manager instance
     * 
     * @example
     * // Called from main bridge
     * interGuildManager.setDiscordManager(discordManager);
     */
    setDiscordManager(discordManager) {
        this._discordManager = discordManager;
        logger.bridge('Discord manager reference set in InterGuildManager');
    }

    /**
     * Process a guild message for inter-guild transfer
     * 
     * Main entry point for guild message processing. Handles both regular guild chat
     * and officer chat messages with configurable routing. Performs anti-loop checks,
     * rate limiting, message formatting, and queuing for all target guilds.
     * 
     * Processing flow:
     * 1. Check if inter-guild is enabled
     * 2. Perform anti-loop and duplicate detection
     * 3. Handle officer message routing based on config
     * 4. Get target guilds (all except source)
     * 5. Check rate limiting
     * 6. Format and queue messages for each target
     * 7. Send to Discord if available
     * 
     * Officer chat modes:
     * - If officerToOfficerChat: Route to officer chats
     * - If officerToGuildChat: Also route to guild chats
     * - If neither: Skip officer messages
     * 
     * @async
     * @param {object} messageData - Parsed message data from Minecraft
     * @param {string} messageData.username - Username of sender
     * @param {string} messageData.message - Message content
     * @param {string} [messageData.chatType='guild'] - Chat type ('guild' or 'officer')
     * @param {string} [messageData.rank] - Player rank (optional)
     * @param {object} sourceGuildConfig - Source guild configuration
     * @param {string} sourceGuildConfig.id - Source guild ID
     * @param {string} sourceGuildConfig.name - Source guild name
     * @param {object} sourceGuildConfig.account - Bot account info
     * @param {string} sourceGuildConfig.account.username - Bot username
     * @param {object} minecraftManager - Minecraft manager instance for sending messages
     * 
     * @example
     * await interGuildManager.processGuildMessage(
     *   { username: "Player123", message: "Hello!", chatType: "guild" },
     *   sourceGuildConfig,
     *   minecraftManager
     * );
     */
    async processGuildMessage(messageData, sourceGuildConfig, minecraftManager) {
        if (!this.interGuildConfig.enabled) {
            return;
        }

        try {
            if (this.isMessageLoopOrDuplicate(messageData, sourceGuildConfig)) {
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

            // No rate-limit drop here any more. Pacing is owned by each bot's ChatQueue,
            // which delays writes instead of discarding them; dropping at this layer
            // silently lost guild chat during busy periods.
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

            // Also send to Discord if available (Minecraft -> Discord bridging)
            if (this._discordManager) {
                try {
                    await this._discordManager.sendGuildMessage(messageData, sourceGuildConfig);
                    logger.discord(`[MC→DC] Sent ${messageData.chatType || 'guild'} message to Discord from ${sourceGuildConfig.name}`);
                } catch (error) {
                    logger.logError(error, `Failed to send message to Discord from ${sourceGuildConfig.name}`);
                }
            }

            // Update rate limiting
            this.updateRateLimit(sourceGuildConfig.id);

        } catch (error) {
            logger.logError(error, `Error processing inter-guild message from ${sourceGuildConfig.name}`);
        }
    }

    /**
     * Process officer messages for inter-guild transfer
     * 
     * Specialized handler for officer chat messages. Routes officer messages to other
     * guilds' officer chats when officerToOfficerChat is enabled. Performs same anti-loop
     * checks, rate limiting, and queueing as regular messages.
     * 
     * @async
     * @param {object} messageData - Parsed officer message data
     * @param {string} messageData.username - Username of sender
     * @param {string} messageData.message - Message content
     * @param {string} messageData.chatType - Should be 'officer'
     * @param {object} sourceGuildConfig - Source guild configuration
     * @param {string} sourceGuildConfig.id - Source guild ID
     * @param {string} sourceGuildConfig.name - Source guild name
     * @param {object} minecraftManager - Minecraft manager instance
     * 
     * @example
     * // Internal usage from processGuildMessage
     * await this.processOfficerMessage(
     *   { username: "Officer1", message: "Admin message", chatType: "officer" },
     *   sourceGuildConfig,
     *   minecraftManager
     * );
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

            // Pacing is owned by each bot's ChatQueue - see processGuildMessage
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

            // Also send to Discord staff channel if available
            if (this._discordManager) {
                try {
                    await this._discordManager.sendGuildMessage(messageData, sourceGuildConfig);
                    logger.discord(`[MC→DC] Sent officer message to Discord from ${sourceGuildConfig.name}`);
                } catch (error) {
                    logger.logError(error, `Failed to send officer message to Discord from ${sourceGuildConfig.name}`);
                }
            }

            // Update rate limiting
            this.updateRateLimit(sourceGuildConfig.id);

        } catch (error) {
            logger.logError(error, `Error processing inter-guild officer message from ${sourceGuildConfig.name}`);
        }
    }

    /**
     * Check if message is a loop or duplicate
     * 
     * Performs comprehensive anti-loop and duplicate detection using multiple strategies:
     * 1. Bot message filtering - Always filter messages from own bot
     * 2. Relay pattern detection - Regex patterns for relay formats
     * 3. Message history checking - Recent message tracking per guild
     * 4. Hash-based duplicate detection - Cross-guild duplicate prevention
     * 
     * Relay patterns detected:
     * - "User: message"
     * - "User: User: message"
     * - "User1: User2: message"
     * - "[TAG] User: message"
     * - "[TAG] User [Rank]: message"
     * - "[TAG] [OFFICER] User: message" (officer chat)
     * 
     * @param {object} messageData - Message data to check
     * @param {string} messageData.message - Message content
     * @param {string} messageData.username - Sender username
     * @param {string} [messageData.chatType='guild'] - Chat type
     * @param {object} sourceGuildConfig - Source guild configuration
     * @param {object} sourceGuildConfig.account - Bot account info
     * @param {string} sourceGuildConfig.account.username - Bot username
     * @param {string} sourceGuildConfig.id - Guild ID
     * @returns {boolean} True if message should be filtered (is loop/duplicate)
     * 
     * @example
     * const isDuplicate = manager.isMessageLoopOrDuplicate(messageData, guildConfig);
     * if (isDuplicate) {
     *   logger.debug("Message filtered as duplicate/loop");
     *   return;
     * }
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
            metrics.filtered('inter_guild', 'own_bot_message');
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
            metrics.filtered('inter_guild', 'recent_duplicate');
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
     * Track message for loop detection
     * 
     * Adds message to guild's message history for duplicate detection. Maintains
     * a sliding window of the last 10 messages per guild-chatType combination.
     * 
     * @param {object} messageData - Message data to track
     * @param {string} messageData.message - Message content
     * @param {string} messageData.username - Sender username
     * @param {string} [messageData.chatType='guild'] - Chat type
     * @param {object} sourceGuildConfig - Source guild configuration
     * @param {string} sourceGuildConfig.id - Guild ID
     * 
     * @example
     * // Internal usage after anti-loop check passes
     * this.trackMessage(messageData, sourceGuildConfig);
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
     * Generate hash for message content
     * 
     * Creates a simple hash from username, message, and chat type for duplicate
     * detection across guilds. Uses a basic hash algorithm that converts to 32-bit integer.
     * 
     * @param {string} message - Message content
     * @param {string} username - Username of sender
     * @param {string} [chatType='guild'] - Chat type ('guild' or 'officer')
     * @returns {string} Message hash as string
     * 
     * @example
     * const hash = manager.generateMessageHash("Hello!", "Player123", "guild");
     * // Returns: "123456789" (example hash)
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
     * Start cleanup interval for anti-loop protection
     * 
     * Initiates a periodic cleanup process (every 60 seconds) to remove stale data
     * from anti-loop tracking systems. Prevents memory leaks by removing old hashes
     * and message history outside the detection window.
     * 
     * @example
     * // Internal usage during initialization
     * this.startCleanupInterval();
     */
    startCleanupInterval() {
        setInterval(() => {
            this.cleanupAntiLoopData();
        }, 60000); // Clean up every minute
    }

    /**
     * Clean up old anti-loop data
     * 
     * Removes stale data from message hashes and message history that are older
     * than the duplicate detection window (30 seconds). Runs periodically to
     * prevent memory buildup from tracking systems.
     * 
     * Cleanup operations:
     * - Remove message hashes older than detection window
     * - Filter message history to keep only recent messages
     * - Delete empty message history entries
     * 
     * @example
     * // Called automatically every minute
     * this.cleanupAntiLoopData();
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
    }

    /**
     * Process a guild event for inter-guild transfer
     * 
     * Broadcasts guild events to all connected guilds based on shareableEvents
     * configuration. Performs same-guild verification to prevent loops and sends
     * events to Discord if available.
     * 
     * Shareable event types (default):
     * - welcome: Player joining
     * - disconnect: Player disconnecting
     * - kick: Player kicked
     * - promote: Player promoted
     * - demote: Player demoted
     * - level: Guild level up
     * - motd: MOTD changed
     * 
     * @async
     * @param {object} eventData - Parsed event data from Minecraft
     * @param {string} eventData.type - Event type
     * @param {string} [eventData.username] - Username involved
     * @param {object} sourceGuildConfig - Source guild configuration
     * @param {string} sourceGuildConfig.id - Source guild ID
     * @param {string} sourceGuildConfig.name - Source guild name
     * @param {object} minecraftManager - Minecraft manager instance
     * 
     * @example
     * await interGuildManager.processGuildEvent(
     *   { type: "promote", username: "Player123", toRank: "Officer" },
     *   sourceGuildConfig,
     *   minecraftManager
     * );
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
                    continue;
                }

                await this.sendEventToGuild(
                    eventData, 
                    sourceGuildConfig, 
                    targetGuildConfig, 
                    minecraftManager
                );
            }

            // Also send to Discord if available (Minecraft -> Discord bridging)
            if (this._discordManager) {
                try {
                    await this._discordManager.sendGuildEvent(eventData, sourceGuildConfig);
                    logger.discord(`[MC→DC] Sent ${eventData.type} event to Discord from ${sourceGuildConfig.name}`);
                } catch (error) {
                    logger.logError(error, `Failed to send event to Discord from ${sourceGuildConfig.name}`);
                }
            }
        } catch (error) {
            logger.logError(error, `Error processing inter-guild event from ${sourceGuildConfig.name}`);
        }
    }

    /**
     * Check if source and target guilds are the same
     * 
     * Performs comprehensive check using multiple guild identifiers (ID, name, tag)
     * to ensure we never send messages/events from a guild back to itself.
     * Critical safety function for preventing message loops.
     * 
     * @param {object} sourceGuildConfig - Source guild configuration
     * @param {string} sourceGuildConfig.id - Source guild ID
     * @param {string} sourceGuildConfig.name - Source guild name
     * @param {string} [sourceGuildConfig.tag] - Source guild tag
     * @param {object} targetGuildConfig - Target guild configuration
     * @param {string} targetGuildConfig.id - Target guild ID
     * @param {string} targetGuildConfig.name - Target guild name
     * @param {string} [targetGuildConfig.tag] - Target guild tag
     * @returns {boolean} True if guilds are the same
     * 
     * @example
     * if (manager.isSameGuild(sourceGuild, targetGuild)) {
     *   logger.warn("Prevented self-messaging!");
     *   return;
     * }
     */
    isSameGuild(sourceGuildConfig, targetGuildConfig) {
        // Check multiple identifiers to be absolutely sure
        return sourceGuildConfig.id === targetGuildConfig.id ||
               sourceGuildConfig.name === targetGuildConfig.name ||
               (sourceGuildConfig.tag && targetGuildConfig.tag && sourceGuildConfig.tag === targetGuildConfig.tag);
    }

    /**
     * Send a formatted message to a specific guild
     * 
     * Formats message using MessageFormatter and queues it for reliable delivery
     * to target guild. Includes safety check to prevent self-messaging.
     * 
     * @async
     * @param {object} messageData - Message data to send
     * @param {string} messageData.username - Sender username
     * @param {string} messageData.message - Message content
     * @param {object} sourceGuildConfig - Source guild configuration
     * @param {string} sourceGuildConfig.name - Source guild name
     * @param {string} sourceGuildConfig.id - Source guild ID
     * @param {object} targetGuildConfig - Target guild configuration
     * @param {string} targetGuildConfig.id - Target guild ID
     * @param {string} targetGuildConfig.name - Target guild name
     * @param {object} minecraftManager - Minecraft manager instance
     * 
     * @example
     * // Internal usage from processGuildMessage
     * await this.sendMessageToGuild(
     *   messageData,
     *   sourceGuild,
     *   targetGuild,
     *   minecraftManager
     * );
     */
    async sendMessageToGuild(messageData, sourceGuildConfig, targetGuildConfig, minecraftManager) {
        try {
            // CRITICAL FIX: Additional safety check to prevent sending to same guild
            if (this.isSameGuild(sourceGuildConfig, targetGuildConfig)) {
                logger.warn(`[INTER-GUILD] PREVENTED: Attempted to send message from ${sourceGuildConfig.name} back to itself!`);
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
     * 
     * Formats officer message and queues it for delivery to target guild's officer chat.
     * Includes safety check to prevent self-messaging.
     * 
     * @async
     * @param {object} messageData - Officer message data to send
     * @param {string} messageData.username - Sender username
     * @param {string} messageData.message - Message content
     * @param {string} messageData.chatType - Should be 'officer'
     * @param {object} sourceGuildConfig - Source guild configuration
     * @param {string} sourceGuildConfig.name - Source guild name
     * @param {string} sourceGuildConfig.id - Source guild ID
     * @param {object} targetGuildConfig - Target guild configuration
     * @param {string} targetGuildConfig.id - Target guild ID
     * @param {string} targetGuildConfig.name - Target guild name
     * @param {object} minecraftManager - Minecraft manager instance
     * 
     * @example
     * // Internal usage from processOfficerMessage
     * await this.sendOfficerMessageToGuild(
     *   officerMessageData,
     *   sourceGuild,
     *   targetGuild,
     *   minecraftManager
     * );
     */
    async sendOfficerMessageToGuild(messageData, sourceGuildConfig, targetGuildConfig, minecraftManager) {
        try {
            // CRITICAL FIX: Additional safety check to prevent sending to same guild
            if (this.isSameGuild(sourceGuildConfig, targetGuildConfig)) {
                logger.warn(`[INTER-GUILD] PREVENTED: Attempted to send officer message from ${sourceGuildConfig.name} back to itself!`);
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
     * 
     * Formats guild event and queues it for delivery to target guild. Includes safety
     * check to prevent self-messaging and filters out "unknown_event_type" fallbacks.
     * 
     * @async
     * @param {object} eventData - Event data to send
     * @param {string} eventData.type - Event type
     * @param {string} [eventData.username] - Username involved
     * @param {object} sourceGuildConfig - Source guild configuration
     * @param {string} sourceGuildConfig.name - Source guild name
     * @param {string} sourceGuildConfig.id - Source guild ID
     * @param {object} targetGuildConfig - Target guild configuration
     * @param {string} targetGuildConfig.id - Target guild ID
     * @param {string} targetGuildConfig.name - Target guild name
     * @param {object} minecraftManager - Minecraft manager instance
     * 
     * @example
     * // Internal usage from processGuildEvent
     * await this.sendEventToGuild(
     *   eventData,
     *   sourceGuild,
     *   targetGuild,
     *   minecraftManager
     * );
     */
    async sendEventToGuild(eventData, sourceGuildConfig, targetGuildConfig, minecraftManager) {
        try {
            // CRITICAL FIX: Additional safety check to prevent sending to same guild
            if (this.isSameGuild(sourceGuildConfig, targetGuildConfig)) {
                logger.warn(`[INTER-GUILD] PREVENTED: Attempted to send event ${eventData.type} from ${sourceGuildConfig.name} back to itself!`);
                return;
            }

            // Format event for target guild
            const formattedMessage = this.messageFormatter.formatGuildEvent(
                eventData,
                sourceGuildConfig,
                targetGuildConfig,
                'messagesToMinecraft'
            );

            if (!formattedMessage || formattedMessage === "unknown_event_type") {
                logger.debug(`[${targetGuildConfig.name}] No formatted event generated for ${eventData.type}`);
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
     * 
     * Adds message to delivery queue with Minecraft manager reference. Queue processor
     * will handle actual delivery with retry logic.
     * 
     * @param {object} messageItem - Message item to queue
     * @param {string} messageItem.type - Message type ('message', 'officer_message', 'event')
     * @param {string} messageItem.guildId - Target guild ID
     * @param {string} messageItem.message - Formatted message
     * @param {string} messageItem.targetGuild - Target guild name
     * @param {number} messageItem.attempts - Current attempt count
     * @param {number} messageItem.maxAttempts - Maximum attempts (3)
     * @param {object} minecraftManager - Minecraft manager instance for delivery
     * 
     * @example
     * // Internal usage from send methods
     * this.queueMessage({
     *   type: 'message',
     *   guildId: 'guild123',
     *   message: '[GuildA] Player: Hello!',
     *   attempts: 0,
     *   maxAttempts: 3
     * }, minecraftManager);
     */
    queueMessage(messageItem, minecraftManager) {
        messageItem.minecraftManager = minecraftManager;
        this.messageQueue.push(messageItem);

        logger.debug(`[INTER-GUILD] Message queued (queue size: ${this.messageQueue.length})`);
    }

    /**
     * Start the message queue processor
     * 
     * Initiates the queue processing loop if not already running. The processor
     * continuously checks the queue and delivers messages with 1-second intervals.
     * 
     * @example
     * // Called during initialization if inter-guild is enabled
     * this.startQueueProcessor();
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
     * 
     * Main queue processing loop. Continuously checks for queued messages and delivers
     * them with 1-second intervals. Handles errors with longer retry delays (5 seconds).
     * Runs until stopQueueProcessor() is called.
     * 
     * @async
     * @example
     * // Started automatically by startQueueProcessor()
     * await this.processQueue();
     */
    async processQueue() {
        while (this.isProcessingQueue) {
            try {
                if (this.messageQueue.length === 0) {
                    await this.wait(200); // Idle poll
                    continue;
                }

                const messageItem = this.messageQueue.shift();

                // Dispatch without awaiting delivery. Each target guild has its own
                // ChatQueue that paces that bot independently, so awaiting here would
                // force all guilds to share a single global send rate - which is what
                // the old fixed 1s sleep did, throttling three bots down to one bot's
                // worth of throughput.
                this.deliverQueuedMessage(messageItem).catch(error => {
                    logger.logError(error, `[INTER-GUILD] Delivery failed for ${messageItem.targetGuild}`);
                });

                // Small yield so a large burst does not block the event loop
                await this.wait(20);

            } catch (error) {
                logger.logError(error, 'Error in queue processor');
                await this.wait(5000); // Wait longer on error
            }
        }
    }

    /**
     * Deliver a queued message
     * 
     * Attempts to deliver a queued message with retry logic. Checks guild connection
     * status, performs final same-guild verification, and sends via appropriate method
     * based on message type. Implements exponential backoff for retries.
     * 
     * Retry logic:
     * - Max 3 attempts per message
     * - Connection check before delivery
     * - Exponential backoff: 2s * attempt number
     * - Final safety check to prevent self-messaging
     * 
     * @async
     * @param {object} messageItem - Message item from queue
     * @param {string} messageItem.type - Message type
     * @param {string} messageItem.guildId - Target guild ID
     * @param {string} messageItem.message - Formatted message
     * @param {string} messageItem.targetGuild - Target guild name
     * @param {number} messageItem.attempts - Current attempt count
     * @param {number} messageItem.maxAttempts - Maximum attempts
     * @param {string} [messageItem.sourceGuildId] - Source guild ID (for safety check)
     * @param {string} [messageItem.targetGuildId] - Target guild ID (for safety check)
     * @param {object} messageItem.minecraftManager - Minecraft manager instance
     * 
     * @example
     * // Called by queue processor
     * await this.deliverQueuedMessage(messageItem);
     */
    async deliverQueuedMessage(messageItem) {
        try {
            messageItem.attempts++;

            // FINAL SAFETY CHECK: Ensure we're not about to send to the same guild
            if (messageItem.sourceGuildId && messageItem.targetGuildId && 
                messageItem.sourceGuildId === messageItem.targetGuildId) {
                logger.error(`[INTER-GUILD] FINAL BLOCK: Prevented sending ${messageItem.type} from ${messageItem.sourceGuild} to itself at delivery time!`);
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
                }

                metrics.dropped(
                    'inter_guild',
                    'target_never_connected',
                    `${messageItem.targetGuild}: ${messageItem.message.substring(0, 60)}`
                );
                return;
            }

            // Send the message based on type. These awaits now resolve when the bot has
            // actually written to the server, not when the write was merely requested.
            const options = { direction: 'inter_guild' };

            if (messageItem.type === 'officer_message') {
                await messageItem.minecraftManager.sendOfficerMessage(messageItem.guildId, messageItem.message, options);
                logger.bridge(`[INTER-GUILD] Delivered officer message to ${messageItem.targetGuild}: "${messageItem.message}"`);
            } else {
                await messageItem.minecraftManager.sendMessage(messageItem.guildId, messageItem.message, options);
                logger.bridge(`[INTER-GUILD] Delivered ${messageItem.type} to ${messageItem.targetGuild}: "${messageItem.message}"`);
            }

        } catch (error) {
            if (messageItem.attempts < messageItem.maxAttempts) {
                logger.warn(`[${messageItem.targetGuild}] Failed to deliver message (attempt ${messageItem.attempts}/${messageItem.maxAttempts}), re-queueing`);
                setTimeout(() => {
                    this.messageQueue.push(messageItem);
                }, 2000 * messageItem.attempts); // Exponential backoff
            } else {
                metrics.dropped(
                    'inter_guild',
                    'max_attempts',
                    `${messageItem.targetGuild}: ${error.message}`
                );
            }
        }
    }

    /**
     * Check if a guild is rate limited
     * 
     * Determines if guild has exceeded rate limit based on recent message timestamps.
     * Rate limit disabled if limit is 0 or negative.
     * 
     * Default rate limit: 2 messages per 10 seconds
     * 
     * @param {string} guildId - Guild ID to check
     * @returns {boolean} True if guild is rate limited
     * 
     * @example
     * if (manager.isRateLimited(guildId)) {
     *   logger.debug("Guild is rate limited");
     *   return;
     * }
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
     * 
     * Records current timestamp for guild and removes old timestamps outside the
     * rate limit window. Called after successfully processing a message.
     * 
     * @param {string} guildId - Guild ID to update
     * 
     * @example
     * // Called after message processing
     * this.updateRateLimit(sourceGuildConfig.id);
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
     * 
     * Determines if event type is in the shareableEvents configuration list.
     * Default shareable events: welcome, disconnect, kick, promote, demote, level, motd
     * 
     * @param {string} eventType - Event type to check
     * @returns {boolean} True if event should be shared
     * 
     * @example
     * if (manager.shouldShareEvent('promote')) {
     *   // Process event for inter-guild sharing
     * }
     */
    shouldShareEvent(eventType) {
        const shareableEvents = this.interGuildConfig.shareableEvents || [
            'welcome', 'disconnect', 'kick', 'promote', 'demote', 'level', 'motd'
        ];

        return shareableEvents.includes(eventType);
    }

    /**
     * Stop the queue processor
     * 
     * Stops the queue processing loop. Queued messages will remain in queue
     * and can be processed again if processor is restarted.
     * 
     * @example
     * // During shutdown
     * manager.stopQueueProcessor();
     */
    stopQueueProcessor() {
        this.isProcessingQueue = false;
    }

    /**
     * Update configuration
     * 
     * Dynamically updates inter-guild configuration and propagates relevant
     * changes to message formatter. Allows runtime configuration changes.
     * 
     * @param {object} newConfig - New configuration options to merge
     * @param {boolean} [newConfig.enabled] - Enable/disable inter-guild
     * @param {boolean} [newConfig.showTags] - Update tag display
     * @param {boolean} [newConfig.showSourceTag] - Update source tag prefix
     * 
     * @example
     * manager.updateConfig({
     *   showTags: true,
     *   officerToOfficerChat: true
     * });
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
     * Clear rate limiter
     * 
     * Clears all rate limiting data. Useful for testing or administrative resets.
     * 
     * @example
     * manager.clearRateLimit();
     */
    clearRateLimit() {
        this.rateLimiter.clear();
        logger.debug('InterGuildManager rate limiter cleared');
    }

    /**
     * Clear message queue
     * 
     * Removes all pending messages from delivery queue. Messages will be lost.
     * 
     * @example
     * manager.clearQueue();
     */
    clearQueue() {
        this.messageQueue.length = 0;
        logger.debug('InterGuildManager message queue cleared');
    }

    /**
     * Clear anti-loop data
     * 
     * Clears message hashes and message history used for anti-loop detection.
     * Use with caution as this removes duplicate protection temporarily.
     * 
     * @example
     * manager.clearAntiLoopData();
     */
    clearAntiLoopData() {
        this.messageHashes.clear();
        this.messageHistory.clear();
        logger.debug('InterGuildManager anti-loop data cleared');
    }

    /**
     * Wait utility function
     * 
     * Simple async delay utility for queue processing and retry logic.
     * 
     * @param {number} ms - Milliseconds to wait
     * @returns {Promise} Promise that resolves after the delay
     * 
     * @example
     * await this.wait(1000); // Wait 1 second
     */
    wait(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
}

module.exports = InterGuildManager;