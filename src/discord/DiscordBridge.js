// Specific Imports
const BridgeLocator = require("../bridgeLocator.js");
const logger = require("../shared/logger");

class DiscordBridge {
    constructor(webhookManager) {
        const mainBridge = BridgeLocator.getInstance();
        this.config = mainBridge.config;
        
        this.webhookManager = webhookManager;
        this.minecraftManager = null;
        
        // Configuration
        this.bridgeConfig = this.config.get('bridge');
        this.isEnabled = this.bridgeConfig.interGuild?.enabled !== false;
        
        // Event filtering
        this.enabledEvents = this.bridgeConfig.interGuild?.shareableEvents || [
            'welcome', 'kick', 'promote', 'demote', 'level', 'motd'
        ];
        
        // Officer chat configuration
        this.officerChatEnabled = this.bridgeConfig.interGuild?.officerToDiscord !== false; // enabled by default
        
        // Channel routing
        this.channelRouting = {
            guild: 'chat',      // Guild messages go to chat channel
            officer: 'staff',   // Officer messages go to staff channel
            events: 'chat'      // Events go to chat channel
        };
        
        // Statistics
        this.stats = {
            messagesProcessed: 0,
            officerMessagesProcessed: 0,
            eventsProcessed: 0,
            messagesDropped: 0,
            errors: 0,
            startTime: Date.now()
        };
        
        // Message deduplication
        this.messageHashes = new Map();
        this.deduplicationWindow = 30000; // 30 seconds
        
        this.isInitialized = false;
    }

    initialize() {
        if (this.isInitialized) {
            logger.warn('DiscordBridge already initialized');
            return;
        }

        if (!this.isEnabled) {
            logger.discord('🔒 DiscordBridge disabled in configuration');
            return;
        }

        try {
            // Get MinecraftManager instance
            const mainBridge = BridgeLocator.getInstance();
            this.minecraftManager = mainBridge.getMinecraftManager();
            
            if (!this.minecraftManager) {
                throw new Error('MinecraftManager not available');
            }

            // Set up event listeners
            this.setupEventListeners();
            
            this.isInitialized = true;
            logger.discord('✅ DiscordBridge initialized and listening for guild events');
            
            // Start cleanup interval
            this.startCleanupInterval();

        } catch (error) {
            logger.logError(error, 'Failed to initialize DiscordBridge');
            throw error;
        }
    }

    setupEventListeners() {
        // Listen for guild messages
        this.minecraftManager.onMessage((messageData) => {
            this.handleGuildMessage(messageData);
        });

        // Listen for guild events
        this.minecraftManager.onEvent((eventData) => {
            this.handleGuildEvent(eventData);
        });

        logger.debug('DiscordBridge event listeners configured');
    }

    /**
     * Handle guild message from Minecraft
     * @param {object} messageData - Parsed message data
     */
    async handleGuildMessage(messageData) {
        try {
            // Only process guild chat messages
            if (messageData.type !== 'guild_chat') {
                return;
            }

            const guildConfig = this.getGuildConfig(messageData.guildId);
            if (!guildConfig) {
                logger.warn(`Guild config not found for message: ${messageData.guildId}`);
                return;
            }

            // Check for message deduplication
            if (this.isDuplicateMessage(messageData)) {
                logger.debug(`[${guildConfig.name}] Duplicate message filtered`);
                return;
            }

            // Determine channel type based on chat type
            let channelType = 'chat';
            if (messageData.chatType === 'officer') {
                if (!this.officerChatEnabled) {
                    logger.debug(`[${guildConfig.name}] Officer chat to Discord disabled`);
                    return;
                }
                channelType = this.channelRouting.officer;
                this.stats.officerMessagesProcessed++;
            } else {
                this.stats.messagesProcessed++;
            }

            // Track message for deduplication
            this.trackMessage(messageData);

            // Send via webhook
            const success = await this.webhookManager.sendGuildMessage(
                messageData, 
                guildConfig, 
                channelType
            );

            if (success) {
                const chatType = messageData.chatType === 'officer' ? 'officer' : 'guild';
                logger.bridge(`[DISCORD] ${chatType.toUpperCase()} message sent: [${guildConfig.name}] ${messageData.username} -> "${messageData.message}"`);
            } else {
                logger.warn(`[${guildConfig.name}] Failed to send ${messageData.chatType || 'guild'} message to Discord`);
                this.stats.messagesDropped++;
            }

        } catch (error) {
            logger.logError(error, `Error handling guild message for Discord`);
            this.stats.errors++;
        }
    }

    /**
     * Handle guild event from Minecraft
     * @param {object} eventData - Parsed event data
     */
    async handleGuildEvent(eventData) {
        try {
            // Check if this event type should be sent to Discord
            if (!this.shouldProcessEvent(eventData.type)) {
                logger.debug(`Event ${eventData.type} not configured for Discord`);
                return;
            }

            const guildConfig = this.getGuildConfig(eventData.guildId);
            if (!guildConfig) {
                logger.warn(`Guild config not found for event: ${eventData.guildId}`);
                return;
            }

            // Check for event deduplication
            if (this.isDuplicateEvent(eventData)) {
                logger.debug(`[${guildConfig.name}] Duplicate event filtered: ${eventData.type}`);
                return;
            }

            // Track event for deduplication
            this.trackEvent(eventData);

            // Send via webhook
            const channelType = this.channelRouting.events;
            const success = await this.webhookManager.sendGuildEvent(
                eventData, 
                guildConfig, 
                channelType
            );

            if (success) {
                logger.bridge(`[DISCORD] EVENT sent: [${guildConfig.name}] ${eventData.type} - ${eventData.username || 'system'}`);
                this.stats.eventsProcessed++;
            } else {
                logger.warn(`[${guildConfig.name}] Failed to send event ${eventData.type} to Discord`);
                this.stats.messagesDropped++;
            }

        } catch (error) {
            logger.logError(error, `Error handling guild event for Discord`);
            this.stats.errors++;
        }
    }

    /**
     * Check if message is duplicate
     * @param {object} messageData - Message data
     * @returns {boolean} Whether message is duplicate
     */
    isDuplicateMessage(messageData) {
        const hash = this.createMessageHash(messageData);
        const existing = this.messageHashes.get(hash);
        
        if (existing) {
            const timeDiff = Date.now() - existing.timestamp;
            if (timeDiff < this.deduplicationWindow) {
                existing.count++;
                return existing.count > 1; // Allow first duplicate, filter subsequent ones
            }
        }
        
        return false;
    }

    /**
     * Check if event is duplicate
     * @param {object} eventData - Event data
     * @returns {boolean} Whether event is duplicate
     */
    isDuplicateEvent(eventData) {
        const hash = this.createEventHash(eventData);
        const existing = this.messageHashes.get(hash);
        
        if (existing) {
            const timeDiff = Date.now() - existing.timestamp;
            if (timeDiff < this.deduplicationWindow) {
                existing.count++;
                return existing.count > 1;
            }
        }
        
        return false;
    }

    /**
     * Track message for deduplication
     * @param {object} messageData - Message data
     */
    trackMessage(messageData) {
        const hash = this.createMessageHash(messageData);
        this.messageHashes.set(hash, {
            timestamp: Date.now(),
            count: 1,
            type: 'message'
        });
    }

    /**
     * Track event for deduplication
     * @param {object} eventData - Event data
     */
    trackEvent(eventData) {
        const hash = this.createEventHash(eventData);
        this.messageHashes.set(hash, {
            timestamp: Date.now(),
            count: 1,
            type: 'event'
        });
    }

    /**
     * Create hash for message
     * @param {object} messageData - Message data
     * @returns {string} Message hash
     */
    createMessageHash(messageData) {
        const content = `msg:${messageData.guildId}:${messageData.username}:${messageData.message}:${messageData.chatType || 'guild'}`;
        return this.simpleHash(content);
    }

    /**
     * Create hash for event
     * @param {object} eventData - Event data
     * @returns {string} Event hash
     */
    createEventHash(eventData) {
        const content = `evt:${eventData.guildId}:${eventData.type}:${eventData.username || 'system'}`;
        return this.simpleHash(content);
    }

    /**
     * Simple hash function
     * @param {string} str - String to hash
     * @returns {string} Hash
     */
    simpleHash(str) {
        let hash = 0;
        for (let i = 0; i < str.length; i++) {
            const char = str.charCodeAt(i);
            hash = ((hash << 5) - hash) + char;
            hash = hash & hash; // Convert to 32-bit integer
        }
        return hash.toString();
    }

    /**
     * Check if event should be processed
     * @param {string} eventType - Event type
     * @returns {boolean} Whether to process event
     */
    shouldProcessEvent(eventType) {
        return this.enabledEvents.includes(eventType);
    }

    /**
     * Get guild configuration by ID
     * @param {string} guildId - Guild ID
     * @returns {object|null} Guild configuration
     */
    getGuildConfig(guildId) {
        const allGuilds = this.config.getEnabledGuilds();
        return allGuilds.find(guild => guild.id === guildId) || null;
    }

    /**
     * Start cleanup interval for deduplication data
     */
    startCleanupInterval() {
        setInterval(() => {
            this.cleanupDeduplicationData();
        }, 60000); // Clean up every minute
    }

    /**
     * Clean up old deduplication data
     */
    cleanupDeduplicationData() {
        const now = Date.now();
        const cutoff = now - this.deduplicationWindow;
        let cleaned = 0;

        for (const [hash, data] of this.messageHashes.entries()) {
            if (data.timestamp < cutoff) {
                this.messageHashes.delete(hash);
                cleaned++;
            }
        }

        if (cleaned > 0) {
            logger.debug(`DiscordBridge cleaned ${cleaned} old deduplication entries`);
        }
    }

    /**
     * Send system notification to Discord
     * @param {string} message - Notification message
     * @param {string} level - Notification level (info, warning, error)
     * @param {string} channelType - Channel type (chat, staff)
     */
    async sendSystemNotification(message, level = 'info', channelType = 'chat') {
        if (!this.isEnabled) {
            return;
        }

        try {
            const avatarUrl = this.getSystemAvatarForLevel(level);
            const username = this.getSystemUsernameForLevel(level);

            await this.webhookManager.sendSystemMessage(message, channelType, {
                username: username,
                avatarURL: avatarUrl
            });

            logger.discord(`System ${level} sent to Discord: "${message}"`);

        } catch (error) {
            logger.logError(error, `Failed to send system notification to Discord`);
        }
    }

    /**
     * Get system avatar based on notification level
     * @param {string} level - Notification level
     * @returns {string} Avatar URL
     */
    getSystemAvatarForLevel(level) {
        const avatars = {
            info: 'https://cdn.discordapp.com/embed/avatars/3.png',
            success: 'https://cdn.discordapp.com/embed/avatars/2.png',
            warning: 'https://cdn.discordapp.com/embed/avatars/1.png',
            error: 'https://cdn.discordapp.com/embed/avatars/4.png'
        };

        return avatars[level] || avatars.info;
    }

    /**
     * Get system username based on notification level
     * @param {string} level - Notification level
     * @returns {string} Username
     */
    getSystemUsernameForLevel(level) {
        const usernames = {
            info: 'System Info',
            success: 'System Success',
            warning: 'System Warning',
            error: 'System Error'
        };

        return usernames[level] || usernames.info;
    }

    /**
     * Update configuration
     * @param {object} newConfig - New configuration
     */
    updateConfig(newConfig) {
        this.bridgeConfig = { ...this.bridgeConfig, ...newConfig };
        this.isEnabled = this.bridgeConfig.interGuild?.enabled !== false;
        this.officerChatEnabled = this.bridgeConfig.interGuild?.officerToDiscord !== false;
        this.enabledEvents = this.bridgeConfig.interGuild?.shareableEvents || this.enabledEvents;

        logger.debug('DiscordBridge configuration updated');
    }

    /**
     * Get bridge statistics
     * @returns {object} Statistics
     */
    getStatistics() {
        return {
            ...this.stats,
            uptime: Date.now() - this.stats.startTime,
            deduplicationCacheSize: this.messageHashes.size,
            isEnabled: this.isEnabled,
            isInitialized: this.isInitialized,
            config: {
                officerChatEnabled: this.officerChatEnabled,
                enabledEvents: this.enabledEvents,
                channelRouting: this.channelRouting
            }
        };
    }

    /**
     * Health check
     * @returns {object} Health status
     */
    async healthCheck() {
        const health = {
            healthy: true,
            issues: []
        };

        if (!this.isEnabled) {
            health.issues.push('DiscordBridge is disabled');
            return health;
        }

        if (!this.isInitialized) {
            health.healthy = false;
            health.issues.push('DiscordBridge not initialized');
        }

        if (!this.minecraftManager) {
            health.healthy = false;
            health.issues.push('MinecraftManager not available');
        }

        if (!this.webhookManager) {
            health.healthy = false;
            health.issues.push('WebhookManager not available');
        }

        if (this.stats.errors > 5) {
            health.issues.push(`High error count: ${this.stats.errors}`);
        }

        if (this.stats.messagesDropped > 10) {
            health.issues.push(`Many messages dropped: ${this.stats.messagesDropped}`);
        }

        return health;
    }

    /**
     * Test Discord bridge functionality
     * @returns {Promise<object>} Test results
     */
    async testBridge() {
        const testResults = {
            timestamp: new Date().toISOString(),
            tests: {
                configuration: false,
                webhookManager: false,
                systemNotification: false
            },
            errors: []
        };

        // Test configuration
        try {
            const guildConfigs = this.config.getEnabledGuilds();
            testResults.tests.configuration = guildConfigs.length > 0;
            
            if (!testResults.tests.configuration) {
                testResults.errors.push('No enabled guilds found');
            }
        } catch (error) {
            testResults.errors.push(`Configuration test failed: ${error.message}`);
        }

        // Test webhook manager
        try {
            if (this.webhookManager) {
                const webhookHealth = await this.webhookManager.healthCheck();
                testResults.tests.webhookManager = webhookHealth.healthy;
                
                if (!webhookHealth.healthy) {
                    testResults.errors.push(...webhookHealth.issues);
                }
            } else {
                testResults.errors.push('WebhookManager not available');
            }
        } catch (error) {
            testResults.errors.push(`WebhookManager test failed: ${error.message}`);
        }

        // Test system notification
        try {
            await this.sendSystemNotification('🧪 Discord Bridge Test Message', 'info', 'chat');
            testResults.tests.systemNotification = true;
        } catch (error) {
            testResults.errors.push(`System notification test failed: ${error.message}`);
        }

        return testResults;
    }

    /**
     * Stop the Discord bridge
     */
    stop() {
        this.isInitialized = false;
        
        // Clear deduplication cache
        this.messageHashes.clear();
        
        logger.debug('DiscordBridge stopped');
    }
}

module.exports = DiscordBridge;