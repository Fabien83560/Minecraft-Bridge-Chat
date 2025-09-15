// Specific Imports
const BridgeLocator = require("../../../bridgeLocator.js");
const MessageCleaner = require("./utils/MessageCleaner.js");
const EventPatterns = require("./patterns/EventPatterns.js");
const logger = require("../../../shared/logger");

class EventParser {
    constructor() {
        const mainBridge = BridgeLocator.getInstance();
        this.config = mainBridge.config;
        
        this.eventParserConfig = this.config.get("features.eventParser");

        this._patterns = new EventPatterns(this.eventParserConfig);
        this._cleaner = new MessageCleaner(this.config.get("advanced.messageCleaner"));

        this.eventCooldowns = new Map();
    }

    /**
     * Parse a raw event message
     * @param {string|object} rawMessage - Raw message from Minecraft client
     * @param {object} guildConfig - Guild configuration
     * @returns {object|null} Parsed event object or null
     */
    parseEvent(rawMessage, guildConfig) {
        const startTime = Date.now();

        try {
            // Clean and normalize the message
            const messageText = this._cleaner.cleanMessage(rawMessage);

            if (this.config.enableDebugLogging) {
                logger.debug(`[${guildConfig.name}] Parsing event: "${messageText}"`);
            }

            // Check if this is actually an event
            if (!this._patterns.isGuildEvent(messageText)) {
                return null;
            }

            // Match the event pattern
            const eventMatch = this._patterns.matchEvent(messageText);
            if (!eventMatch) {
                return null;
            }

            // Check event cooldown
            if (this.isEventInCooldown(eventMatch, guildConfig)) {
                logger.debug(`[${guildConfig.name}] Event in cooldown: ${eventMatch.type}`);
                return null;
            }

            // Create parsed event result
            const parsedEvent = this.createEventResult(eventMatch, messageText, guildConfig);

            // Set cooldown for this event
            this.setEventCooldown(eventMatch, guildConfig);

            logger.debug(`[${guildConfig.name}] Event parsed: ${parsedEvent.type} - ${parsedEvent.username || 'system'}`);

            return parsedEvent;

        } catch (error) {
            logger.logError(error, `Error parsing event from ${guildConfig.name}`);
            return this.createErrorEventResult(rawMessage, error, guildConfig);
        }
    }

    /**
     * Create event result from matched pattern
     * @param {object} eventMatch - Matched event from patterns
     * @param {string} messageText - Original message text
     * @param {object} guildConfig - Guild configuration
     * @returns {object} Complete event result
     */
    createEventResult(eventMatch, messageText, guildConfig) {
        const baseResult = {
            // Event identification
            type: eventMatch.type,
            raw: messageText,
            originalRaw: eventMatch.raw,
            
            // Guild information
            guildId: guildConfig.id,
            guildName: guildConfig.name,
            guildTag: guildConfig.tag,
            
            // Parsing metadata
            timestamp: Date.now(),
            parsedSuccessfully: true,
            parser: 'EventParser',
            parserVersion: '2.0.0',
            patternIndex: eventMatch.patternIndex,
            isCustomPattern: eventMatch.isCustomPattern || false
        };

        // Add event-specific data based on type
        switch (eventMatch.type) {
            case 'join':
                return {
                    ...baseResult,
                    username: eventMatch.username,
                    rank: eventMatch.rank || null,
                    welcomeMessage: this.generateWelcomeMessage(eventMatch.username, guildConfig)
                };

            case 'leave':
                return {
                    ...baseResult,
                    username: eventMatch.username,
                    reason: eventMatch.reason || null,
                    wasKicked: false
                };

            case 'kick':
                return {
                    ...baseResult,
                    username: eventMatch.username,
                    kickedBy: eventMatch.kickedBy || 'Unknown',
                    reason: eventMatch.reason || null,
                    wasKicked: true
                };

            case 'promote':
                return {
                    ...baseResult,
                    username: eventMatch.username,
                    fromRank: eventMatch.fromRank || 'Unknown',
                    toRank: eventMatch.toRank,
                    promoter: eventMatch.promoter || null,
                    isPromotion: true
                };

            case 'demote':
                return {
                    ...baseResult,
                    username: eventMatch.username,
                    fromRank: eventMatch.fromRank || 'Unknown',
                    toRank: eventMatch.toRank,
                    demoter: eventMatch.demoter || null,
                    isPromotion: false
                };

            case 'invite':
                return {
                    ...baseResult,
                    inviter: eventMatch.inviter,
                    invited: eventMatch.invited,
                    inviteAccepted: eventMatch.raw.toLowerCase().includes('accepted')
                };

            case 'online':
                return {
                    ...baseResult,
                    count: eventMatch.count || 0,
                    membersList: eventMatch.membersList || '',
                    members: eventMatch.members || [],
                    onlineCount: eventMatch.members ? eventMatch.members.length : eventMatch.count
                };

            case 'level':
                return {
                    ...baseResult,
                    level: eventMatch.level,
                    previousLevel: Math.max(1, eventMatch.level - 1),
                    isLevelUp: true
                };

            case 'motd':
                return {
                    ...baseResult,
                    changer: eventMatch.changer,
                    motd: eventMatch.motd,
                    previousMotd: null // Could be tracked if needed
                };

            case 'misc':
                return {
                    ...baseResult,
                    changer: eventMatch.changer || null,
                    newTag: eventMatch.newTag || null,
                    newName: eventMatch.newName || null,
                    changeType: this.determineChangeType(eventMatch)
                };

            default:
                return {
                    ...baseResult,
                    eventData: eventMatch,
                    isUnknownEventType: true
                };
        }
    }

    /**
     * Create error event result
     * @param {string} rawMessage - Original raw message
     * @param {Error} error - Error that occurred
     * @param {object} guildConfig - Guild configuration
     * @returns {object} Error event result
     */
    createErrorEventResult(rawMessage, error, guildConfig) {
        return {
            type: 'parsing_error',
            raw: typeof rawMessage === 'string' ? rawMessage : String(rawMessage),
            error: {
                message: error.message,
                stack: error.stack
            },
            guildId: guildConfig.id,
            guildName: guildConfig.name,
            timestamp: Date.now(),
            parsedSuccessfully: false,
            parser: 'EventParser',
            parserVersion: '2.0.0'
        };
    }

    /**
     * Check if event is in cooldown period
     * @param {object} eventMatch - Matched event
     * @param {object} guildConfig - Guild configuration
     * @returns {boolean} Whether event is in cooldown
     */
    isEventInCooldown(eventMatch, guildConfig) {
        if (this.config.eventCooldown <= 0) {
            return false; // Cooldown disabled
        }

        const cooldownKey = this.generateCooldownKey(eventMatch, guildConfig);
        const lastEventTime = this.eventCooldowns.get(cooldownKey);
        
        if (!lastEventTime) {
            return false; // No previous event
        }

        const timeSinceLastEvent = Date.now() - lastEventTime;
        return timeSinceLastEvent < this.config.eventCooldown;
    }

    /**
     * Set cooldown for event
     * @param {object} eventMatch - Matched event
     * @param {object} guildConfig - Guild configuration
     */
    setEventCooldown(eventMatch, guildConfig) {
        if (this.config.eventCooldown <= 0) {
            return; // Cooldown disabled
        }

        const cooldownKey = this.generateCooldownKey(eventMatch, guildConfig);
        this.eventCooldowns.set(cooldownKey, Date.now());

        // Clean up old cooldown entries periodically
        if (this.eventCooldowns.size > 1000) {
            this.cleanupOldCooldowns();
        }
    }

    /**
     * Generate cooldown key for event
     * @param {object} eventMatch - Matched event
     * @param {object} guildConfig - Guild configuration
     * @returns {string} Cooldown key
     */
    generateCooldownKey(eventMatch, guildConfig) {
        // For user-specific events, include username in key
        if (eventMatch.username) {
            return `${guildConfig.id}-${eventMatch.type}-${eventMatch.username}`;
        }
        
        // For system events, just use guild and type
        return `${guildConfig.id}-${eventMatch.type}`;
    }

    /**
     * Clean up old cooldown entries
     */
    cleanupOldCooldowns() {
        const now = Date.now();
        const cutoff = now - (this.config.eventCooldown * 2); // Keep entries for 2x cooldown period

        for (const [key, timestamp] of this.eventCooldowns.entries()) {
            if (timestamp < cutoff) {
                this.eventCooldowns.delete(key);
            }
        }

        logger.debug(`Cleaned up old event cooldowns, ${this.eventCooldowns.size} entries remaining`);
    }

    /**
     * Generate welcome message for new members
     * @param {string} username - New member username
     * @param {object} guildConfig - Guild configuration
     * @returns {string} Welcome message
     */
    generateWelcomeMessage(username, guildConfig) {
        const welcomeMessages = [
            `Welcome ${username} to ${guildConfig.name}!`,
            `${username} joined the guild family!`,
            `Everyone welcome ${username}!`,
            `${guildConfig.name} grows stronger with ${username}!`
        ];

        const randomIndex = Math.floor(Math.random() * welcomeMessages.length);
        return welcomeMessages[randomIndex];
    }

    /**
     * Determine change type for misc events
     * @param {object} eventMatch - Event match data
     * @returns {string} Change type
     */
    determineChangeType(eventMatch) {
        if (eventMatch.newTag) return 'tag_change';
        if (eventMatch.newName) return 'name_change';
        if (eventMatch.raw.toLowerCase().includes('description')) return 'description_change';
        if (eventMatch.raw.toLowerCase().includes('settings')) return 'settings_change';
        return 'unknown_change';
    }

    // ==================== UTILITY METHODS ====================

    /**
     * Check if message is a guild event (for external use)
     * @param {string|object} rawMessage - Raw message
     * @param {object} guildConfig - Guild configuration
     * @returns {boolean} Whether message is an event
     */
    isGuildEvent(rawMessage, guildConfig) {
        try {
            const messageText = this._cleaner.cleanMessage(rawMessage);
            return this._patterns.isGuildEvent(messageText);
        } catch (error) {
            logger.logError(error, 'Error checking if message is guild event');
            return false;
        }
    }

    /**
     * Get event type from message
     * @param {string|object} rawMessage - Raw message
     * @param {object} guildConfig - Guild configuration
     * @returns {string|null} Event type or null
     */
    getEventType(rawMessage, guildConfig) {
        try {
            const messageText = this._cleaner.cleanMessage(rawMessage);
            return this._patterns.getEventType(messageText);
        } catch (error) {
            logger.logError(error, 'Error getting event type');
            return null;
        }
    }

    /**
     * Get pattern matcher for external access
     * @returns {EventPatterns} Pattern matcher instance
     */
    getPatterns() {
        return this._patterns;
    }

    /**
     * Get message cleaner for external access
     * @returns {MessageCleaner} Message cleaner instance
     */
    getCleaner() {
        return this._cleaner;
    }

    /**
     * Test event parsing (for debugging)
     * @param {string} messageText - Message to test
     * @param {object} guildConfig - Guild configuration
     * @returns {object} Test results
     */
    testEventParsing(messageText, guildConfig) {
        const testResults = {
            input: messageText,
            cleaned: this._cleaner.cleanMessage(messageText),
            isEvent: this._patterns.isGuildEvent(messageText),
            eventType: this._patterns.getEventType(messageText),
            patternMatch: this._patterns.matchEvent(messageText),
            parsedEvent: null,
            inCooldown: false
        };

        if (testResults.patternMatch) {
            testResults.inCooldown = this.isEventInCooldown(testResults.patternMatch, guildConfig);
            
            if (!testResults.inCooldown) {
                testResults.parsedEvent = this.createEventResult(
                    testResults.patternMatch, 
                    messageText, 
                    guildConfig
                );
            }
        }

        return testResults;
    }
}

module.exports = EventParser;