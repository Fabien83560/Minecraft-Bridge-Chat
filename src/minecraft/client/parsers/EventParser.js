/**
 * Event Parser - Guild Event Detection and Parsing
 * 
 * This file handles the detection, parsing, and structuring of guild events from
 * Minecraft server messages. It transforms raw event messages into structured data
 * objects that can be processed by the bridge system and forwarded to Discord.
 * 
 * Key responsibilities:
 * - Event detection using pattern matching (EventPatterns)
 * - Message cleaning and normalization (MessageCleaner)
 * - Event parsing and data extraction
 * - Cooldown management to prevent duplicate events
 * - Structured event result creation with metadata
 * - Error handling and fallback parsing
 * 
 * Supported event types:
 * - join: Member joins guild
 * - disconnect: Member disconnects/leaves temporarily
 * - leave: Member leaves guild permanently
 * - welcome: Welcome message for new members
 * - kick: Member is kicked from guild
 * - promote: Member rank promotion
 * - demote: Member rank demotion
 * - invite: Guild invite sent/accepted
 * - online: Online members list
 * - level: Guild level up
 * - motd: Message of the day changed
 * - misc: Other changes (tag, name, description, settings)
 * 
 * Event cooldown system:
 * Prevents duplicate event processing by tracking recent events with a cooldown
 * period. Each event type per user has its own cooldown key for granular control.
 * Configurable cooldown period via configuration.
 * 
 * Event result structure:
 * {
 *   type: string,              // Event type
 *   username: string,          // User involved (if applicable)
 *   raw: string,              // Cleaned message text
 *   originalRaw: string,      // Original raw message
 *   guildId: string,          // Guild identifier
 *   guildName: string,        // Guild name
 *   guildTag: string,         // Guild tag
 *   timestamp: number,        // Unix timestamp
 *   parsedSuccessfully: bool, // Parse success flag
 *   parser: string,           // Parser name
 *   parserVersion: string,    // Parser version
 *   patternIndex: number,     // Matched pattern index
 *   ...                       // Event-specific fields
 * }
 * 
 * @author Fabien83560
 * @version 2.0.0
 * @license ISC
 */

// Specific Imports
const BridgeLocator = require("../../../bridgeLocator.js");
const MessageCleaner = require("./utils/MessageCleaner.js");
const EventPatterns = require("./patterns/EventPatterns.js");
const logger = require("../../../shared/logger");
const metrics = require("../../../shared/BridgeMetrics.js");

/**
 * EventParser - Parses guild events from Minecraft messages
 * 
 * Handles event detection, parsing, and cooldown management for all
 * guild-related events on Minecraft servers.
 * 
 * @class
 */
class EventParser {
    /**
     * Initialize the event parser
     * 
     * Sets up:
     * - Configuration from main bridge
     * - Event parser configuration
     * - EventPatterns instance for pattern matching
     * - MessageCleaner instance for message normalization
     * - Cooldown tracking map
     * 
     * @example
     * const parser = new EventParser();
     * const event = parser.parseEvent(message, guildConfig);
     */
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
     * 
     * Main entry point for event parsing. Processes raw Minecraft messages
     * through cleaning, pattern matching, cooldown checking, and result creation.
     * 
     * Processing pipeline:
     * 1. Clean and normalize message text
     * 2. Check if message is a guild event
     * 3. Match event pattern and extract data
     * 4. Check cooldown to prevent duplicates
     * 5. Create structured event result
     * 6. Set cooldown for this event
     * 
     * Returns null if:
     * - Message is not a guild event
     * - No pattern matches
     * - Event is in cooldown period
     * 
     * @param {string|object} rawMessage - Raw message from Minecraft client
     * @param {object} guildConfig - Guild configuration
     * @param {string} guildConfig.id - Guild ID
     * @param {string} guildConfig.name - Guild name
     * @param {string} guildConfig.tag - Guild tag
     * @returns {object|null} Parsed event object or null if not an event
     * 
     * @example
     * const event = parser.parseEvent("Guild > Player joined.", guildConfig);
     * // Returns: { type: 'join', username: 'Player', parsedSuccessfully: true, ... }
     * 
     * @example
     * const event = parser.parseEvent("Guild > Player: Hello", guildConfig);
     * // Returns: null (not an event, just chat)
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
                metrics.filtered('mc_to_discord', `event_cooldown_${eventMatch.type}`);
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
     * 
     * Constructs a complete event result object with base metadata and
     * event-specific data based on the event type. Each event type has
     * its own data structure tailored to that event.
     * 
     * Base result includes:
     * - Event identification (type, raw, originalRaw)
     * - Guild information (guildId, guildName, guildTag)
     * - Parsing metadata (timestamp, parsedSuccessfully, parser, version)
     * - Pattern metadata (patternIndex, isCustomPattern)
     * 
     * Event-specific fields added based on type:
     * - join/leave/kick: username, rank, reason
     * - promote/demote: username, fromRank, toRank, promoter/demoter
     * - invite: inviter, invited, inviteAccepted
     * - online: count, membersList, members, onlineCount
     * - level: level, previousLevel, isLevelUp
     * - motd: changer, motd
     * - misc: changer, newTag, newName, changeType
     * 
     * @param {object} eventMatch - Matched event from patterns
     * @param {string} eventMatch.type - Event type
     * @param {string} eventMatch.raw - Original raw message
     * @param {string} [eventMatch.username] - Username if applicable
     * @param {number} eventMatch.patternIndex - Index of matched pattern
     * @param {boolean} [eventMatch.isCustomPattern] - Whether custom pattern
     * @param {string} messageText - Cleaned message text
     * @param {object} guildConfig - Guild configuration
     * @returns {object} Complete event result with type-specific data
     * 
     * @example
     * const eventMatch = { type: 'join', username: 'Player', raw: '...' };
     * const result = parser.createEventResult(eventMatch, messageText, guildConfig);
     * // Returns: { type: 'join', username: 'Player', rank: null, ... }
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
                    rank: eventMatch.rank || null
                };
            
            case 'disconnect':
                return {
                    ...baseResult,
                    username: eventMatch.username,
                }

            case 'leave':
                return {
                    ...baseResult,
                    username: eventMatch.username,
                    reason: eventMatch.reason || null,
                    wasKicked: false
                };
            
            case 'welcome':
                return {
                    ...baseResult,
                    username: eventMatch.username,
                }

            case 'kick':
                return {
                    ...baseResult,
                    username: eventMatch.username,
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
     * 
     * Creates a structured error result when event parsing fails.
     * Includes error details for debugging while maintaining consistent
     * result structure.
     * 
     * @param {string} rawMessage - Original raw message
     * @param {Error} error - Error that occurred during parsing
     * @param {object} guildConfig - Guild configuration
     * @returns {object} Error event result with parsedSuccessfully: false
     * 
     * @example
     * const errorResult = parser.createErrorEventResult(
     *   message,
     *   new Error('Pattern match failed'),
     *   guildConfig
     * );
     * // Returns: { type: 'parsing_error', parsedSuccessfully: false, ... }
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
     * 
     * Prevents duplicate event processing by checking if the same event
     * was recently processed. Cooldown is configurable via config.eventCooldown.
     * 
     * Cooldown keys are generated per-guild and per-event-type, with additional
     * username differentiation for user-specific events.
     * 
     * @param {object} eventMatch - Matched event data
     * @param {string} eventMatch.type - Event type
     * @param {string} [eventMatch.username] - Username if applicable
     * @param {object} guildConfig - Guild configuration
     * @returns {boolean} Whether event is currently in cooldown
     * 
     * @example
     * const isInCooldown = parser.isEventInCooldown(
     *   { type: 'join', username: 'Player' },
     *   guildConfig
     * );
     * // Returns: true if same event occurred within cooldown period
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
     * 
     * Records current timestamp for this event to prevent duplicate processing.
     * Automatically cleans up old cooldown entries when map grows too large.
     * 
     * @param {object} eventMatch - Matched event data
     * @param {object} guildConfig - Guild configuration
     * 
     * @example
     * parser.setEventCooldown(
     *   { type: 'join', username: 'Player' },
     *   guildConfig
     * );
     * // Event now in cooldown for configured period
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
     * 
     * Creates a unique identifier for cooldown tracking based on:
     * - Guild ID (different guilds track separately)
     * - Event type (different event types track separately)
     * - Username (for user-specific events like join/leave)
     * 
     * System events (level, motd, etc.) only use guild + type.
     * User events include username for per-user cooldown tracking.
     * 
     * @param {object} eventMatch - Matched event data
     * @param {string} eventMatch.type - Event type
     * @param {string} [eventMatch.username] - Username if applicable
     * @param {object} guildConfig - Guild configuration
     * @param {string} guildConfig.id - Guild ID
     * @returns {string} Unique cooldown key
     * 
     * @example
     * const key = parser.generateCooldownKey(
     *   { type: 'join', username: 'Player' },
     *   { id: 'guild1' }
     * );
     * // Returns: "guild1-join-Player"
     * 
     * @example
     * const key = parser.generateCooldownKey(
     *   { type: 'level' },
     *   { id: 'guild1' }
     * );
     * // Returns: "guild1-level"
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
     * 
     * Removes expired cooldown entries to prevent memory growth.
     * Triggered automatically when cooldown map exceeds 1000 entries.
     * Keeps entries within 2x the cooldown period for safety margin.
     * 
     * @example
     * parser.cleanupOldCooldowns();
     * // Removes entries older than 2x cooldown period
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
     * Determine change type for misc events
     * 
     * Analyzes event data and raw message to categorize miscellaneous
     * guild changes into specific types.
     * 
     * Change types:
     * - tag_change: Guild tag changed
     * - name_change: Guild name changed
     * - description_change: Guild description changed
     * - settings_change: Guild settings changed
     * - unknown_change: Other unidentified changes
     * 
     * @param {object} eventMatch - Event match data
     * @param {string} [eventMatch.newTag] - New tag if tag change
     * @param {string} [eventMatch.newName] - New name if name change
     * @param {string} eventMatch.raw - Raw message text
     * @returns {string} Change type identifier
     * 
     * @example
     * const changeType = parser.determineChangeType({
     *   newTag: 'NEW',
     *   raw: 'Guild tag changed to [NEW]'
     * });
     * // Returns: "tag_change"
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
     * 
     * Quick check method to determine if a message is an event
     * without full parsing. Useful for pre-filtering messages.
     * 
     * @param {string|object} rawMessage - Raw message to check
     * @param {object} guildConfig - Guild configuration
     * @returns {boolean} Whether message is a guild event
     * 
     * @example
     * if (parser.isGuildEvent(message, guildConfig)) {
     *   const event = parser.parseEvent(message, guildConfig);
     * }
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
     * 
     * Determines the event type without full parsing.
     * Returns null if message is not an event.
     * 
     * @param {string|object} rawMessage - Raw message
     * @param {object} guildConfig - Guild configuration
     * @returns {string|null} Event type or null if not an event
     * 
     * @example
     * const type = parser.getEventType(message, guildConfig);
     * // Returns: "join" or "leave" or null
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
     * 
     * Provides access to the EventPatterns instance for external
     * pattern management and testing.
     * 
     * @returns {EventPatterns} Pattern matcher instance
     * 
     * @example
     * const patterns = parser.getPatterns();
     * const customPatterns = patterns.getCustomPatterns('join');
     */
    getPatterns() {
        return this._patterns;
    }

    /**
     * Get message cleaner for external access
     * 
     * Provides access to the MessageCleaner instance for external
     * message cleaning operations.
     * 
     * @returns {MessageCleaner} Message cleaner instance
     * 
     * @example
     * const cleaner = parser.getCleaner();
     * const cleaned = cleaner.cleanMessage(rawMessage);
     */
    getCleaner() {
        return this._cleaner;
    }
}

module.exports = EventParser;