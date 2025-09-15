// Specific Imports
const logger = require("../../../shared/logger");
const { getPatternLoader } = require("../../../config/PatternLoader.js");

class EventPatterns {
    constructor(config) {
        this.config = config;
        this.patternLoader = getPatternLoader();
        this.serverType = config.serverType || 'Hypixel';

        // Pattern cache for performance
        this.patternCache = new Map();
        
        // Validate server support
        this.validateServerSupport();
        
        logger.debug(`EventPatterns initialized for server: ${this.serverType}`);
    }

    /**
     * Validate that the configured server is supported
     */
    validateServerSupport() {
        if (!this.patternLoader.isServerSupported(this.serverType)) {
            logger.warn(`Server '${this.serverType}' not found in pattern configuration, falling back to Vanilla`);
            this.serverType = 'Vanilla';
        }
    }

    /**
     * Get patterns for a specific event type
     * @param {string} eventType - Event type (join, leave, kick, etc.)
     * @returns {Array} Array of pattern objects
     */
    getEventPatterns(eventType) {
        const cacheKey = `${this.serverType}-events-${eventType}`;
        
        if (this.patternCache.has(cacheKey)) {
            return this.patternCache.get(cacheKey);
        }

        const patterns = this.patternLoader.getPatterns(this.serverType, 'events', eventType);
        
        // Add custom patterns from configuration if any
        if (this.config.customEventPatterns && this.config.customEventPatterns[eventType]) {
            const customPatterns = this.config.customEventPatterns[eventType].map(patternStr => ({
                pattern: new RegExp(patternStr),
                originalPattern: patternStr,
                groups: this.getDefaultGroups(eventType),
                custom: true,
                description: `Custom ${eventType} pattern`
            }));
            patterns.push(...customPatterns);
        }

        this.patternCache.set(cacheKey, patterns);
        return patterns;
    }

    /**
     * Get default groups for an event type
     * @param {string} eventType - Event type
     * @returns {Array} Default groups for the event type
     */
    getDefaultGroups(eventType) {
        const defaultGroups = {
            'join': ['username'],
            'leave': ['username'],
            'kick': ['username', 'kicker'],
            'promote': ['username', 'toRank'],
            'demote': ['username', 'toRank'],
            'invite': ['inviter', 'invited'],
            'online': ['membersList'],
            'level': ['level'],
            'motd': ['changer', 'motd'],
            'misc': ['changer']
        };

        return defaultGroups[eventType] || [];
    }

    /**
     * Match an event against all patterns
     * @param {string} messageText - Message text to match
     * @returns {object|null} Matched event or null
     */
    matchEvent(messageText) {
        // Clean message text
        const cleanText = this.cleanMessageForMatching(messageText);
        
        if (this.config.enableDebugLogging) {
            logger.debug(`[EventPatterns] Trying to match: "${cleanText}"`);
            logger.debug(`[EventPatterns] Server: ${this.serverType}, Message length: ${cleanText.length}`);
        }
        
        // Get all event types for this server
        const eventTypes = this.patternLoader.getEventTypes(this.serverType);
        
        if (this.config.enableDebugLogging) {
            logger.debug(`[EventPatterns] Available event types: ${eventTypes.join(', ')}`);
        }

        // Try each event type
        for (const eventType of eventTypes) {
            const patterns = this.getEventPatterns(eventType);
            
            if (this.config.enableDebugLogging) {
                logger.debug(`[EventPatterns] Testing ${eventType} patterns (${patterns.length} patterns)`);
            }
            
            for (let i = 0; i < patterns.length; i++) {
                const patternObj = patterns[i];
                if (!patternObj || !patternObj.pattern) continue;

                const match = cleanText.match(patternObj.pattern);
                
                if (this.config.enableDebugLogging) {
                    logger.debug(`[EventPatterns] Pattern ${i} (${patternObj.description}): ${patternObj.originalPattern || patternObj.pattern} -> ${match ? 'MATCH' : 'NO MATCH'}`);
                }
                
                if (match) {
                    if (this.config.enableDebugLogging) {
                        logger.debug(`[EventPatterns] MATCHED! Groups: [${match.slice(1).join(', ')}]`);
                    }
                    return this.parseEventMatch(match, eventType, patternObj, i);
                }
            }
        }

        if (this.config.enableDebugLogging) {
            logger.debug(`[EventPatterns] No patterns matched for: "${cleanText}"`);
        }
        return null;
    }

    /**
     * Parse a matched event
     * @param {Array} match - Regex match result
     * @param {string} eventType - Type of event
     * @param {object} patternObj - Pattern object that matched
     * @param {number} patternIndex - Index of pattern
     * @returns {object} Parsed event data
     */
    parseEventMatch(match, eventType, patternObj, patternIndex) {
        const eventData = {
            type: eventType,
            raw: match[0],
            patternIndex: patternIndex,
            isCustomPattern: patternObj.custom || false,
            groups: patternObj.groups || [],
            description: patternObj.description || 'No description'
        };

        // Map match groups to named properties based on event type and groups definition
        const groups = patternObj.groups || this.getDefaultGroups(eventType);
        
        for (let i = 0; i < groups.length && i + 1 < match.length; i++) {
            const groupName = groups[i];
            const groupValue = match[i + 1];
            
            if (groupValue !== undefined) {
                eventData[groupName] = groupValue;
            }
        }

        // Apply event-specific processing
        return this.processEventData(eventData, eventType, match);
    }

    /**
     * Process event data based on event type
     * @param {object} eventData - Base event data
     * @param {string} eventType - Event type
     * @param {Array} match - Regex match result
     * @returns {object} Processed event data
     */
    processEventData(eventData, eventType, match) {
        switch (eventType) {
            case 'join':
                return this.processJoinEvent(eventData, match);
            case 'leave':
                return this.processLeaveEvent(eventData, match);
            case 'kick':
                return this.processKickEvent(eventData, match);
            case 'promote':
                return this.processPromoteEvent(eventData, match);
            case 'demote':
                return this.processDemoteEvent(eventData, match);
            case 'invite':
                return this.processInviteEvent(eventData, match);
            case 'online':
                return this.processOnlineEvent(eventData, match);
            case 'level':
                return this.processLevelEvent(eventData, match);
            case 'motd':
                return this.processMotdEvent(eventData, match);
            case 'misc':
                return this.processMiscEvent(eventData, match);
            default:
                return eventData;
        }
    }

    /**
     * Process join event data
     */
    processJoinEvent(eventData, match) {
        return {
            ...eventData,
            rank: eventData.rank || null,
            welcomeMessage: this.generateWelcomeMessage(eventData.username)
        };
    }

    /**
     * Process leave event data
     */
    processLeaveEvent(eventData, match) {
        return {
            ...eventData,
            reason: eventData.reason || null,
            wasKicked: false
        };
    }

    /**
     * Process kick event data
     */
    processKickEvent(eventData, match) {
        return {
            ...eventData,
            kickedBy: eventData.kicker || eventData.kickedBy || 'Unknown',
            reason: eventData.reason || null,
            wasKicked: true
        };
    }

    /**
     * Process promote event data
     */
    processPromoteEvent(eventData, match) {
        return {
            ...eventData,
            fromRank: eventData.fromRank || 'Unknown',
            toRank: eventData.toRank,
            promoter: eventData.promoter || null,
            isPromotion: true
        };
    }

    /**
     * Process demote event data
     */
    processDemoteEvent(eventData, match) {
        return {
            ...eventData,
            fromRank: eventData.fromRank || 'Unknown',
            toRank: eventData.toRank,
            demoter: eventData.demoter || null,
            isPromotion: false
        };
    }

    /**
     * Process invite event data
     */
    processInviteEvent(eventData, match) {
        return {
            ...eventData,
            inviteAccepted: eventData.raw && eventData.raw.toLowerCase().includes('accepted')
        };
    }

    /**
     * Process online event data
     */
    processOnlineEvent(eventData, match) {
        const membersList = eventData.membersList || '';
        const members = this.parseOnlineMembers(membersList);
        
        return {
            ...eventData,
            count: eventData.count || members.length,
            members: members,
            onlineCount: members.length
        };
    }

    /**
     * Process level event data
     */
    processLevelEvent(eventData, match) {
        const level = parseInt(eventData.level);
        return {
            ...eventData,
            level: level,
            previousLevel: Math.max(1, level - 1),
            isLevelUp: true
        };
    }

    /**
     * Process MOTD event data
     */
    processMotdEvent(eventData, match) {
        return {
            ...eventData,
            previousMotd: null // Could be tracked if needed
        };
    }

    /**
     * Process misc event data
     */
    processMiscEvent(eventData, match) {
        return {
            ...eventData,
            changeType: this.determineChangeType(eventData)
        };
    }

    /**
     * Clean message text for matching
     * @param {string} messageText - Raw message text
     * @returns {string} Cleaned text
     */
    cleanMessageForMatching(messageText) {
        if (!messageText || typeof messageText !== 'string') {
            return '';
        }

        let cleaned = messageText;

        // Remove color codes if not enabled
        if (!this.config.enableColorCodes) {
            const colorCodePattern = this.patternLoader.getDefaults('colorCodes').all;
            if (colorCodePattern) {
                cleaned = cleaned.replace(new RegExp(colorCodePattern, 'g'), '');
            }
        }

        return cleaned.trim();
    }

    /**
     * Parse online members list
     * @param {string} membersList - String of online members
     * @returns {Array} Array of member names
     */
    parseOnlineMembers(membersList) {
        if (!membersList || typeof membersList !== 'string') {
            return [];
        }

        return membersList
            .split(',')
            .map(member => member.trim())
            .filter(member => member.length > 0)
            .map(member => {
                // Remove rank prefixes like [VIP] or color codes
                return member
                    .replace(/\[[^\]]+\]/g, '')
                    .replace(/§[0-9a-fklmnor]/g, '')
                    .trim();
            })
            .filter(member => member.length > 0);
    }

    /**
     * Generate welcome message for new members
     * @param {string} username - New member username
     * @returns {string} Welcome message
     */
    generateWelcomeMessage(username) {
        const welcomeMessages = [
            `Welcome ${username} to the guild!`,
            `${username} joined the guild family!`,
            `Everyone welcome ${username}!`,
            `The guild grows stronger with ${username}!`
        ];

        const randomIndex = Math.floor(Math.random() * welcomeMessages.length);
        return welcomeMessages[randomIndex];
    }

    /**
     * Determine change type for misc events
     * @param {object} eventData - Event data
     * @returns {string} Change type
     */
    determineChangeType(eventData) {
        if (eventData.newTag) return 'tag_change';
        if (eventData.newName) return 'name_change';
        if (eventData.raw && eventData.raw.toLowerCase().includes('description')) return 'description_change';
        if (eventData.raw && eventData.raw.toLowerCase().includes('settings')) return 'settings_change';
        return 'unknown_change';
    }

    /**
     * Check if message is a guild event
     * @param {string} messageText - Message text to check
     * @returns {boolean} Whether message is an event
     */
    isGuildEvent(messageText) {
        return this.matchEvent(messageText) !== null;
    }

    /**
     * Get event type from message
     * @param {string} messageText - Message text
     * @returns {string|null} Event type or null
     */
    getEventType(messageText) {
        const match = this.matchEvent(messageText);
        return match ? match.type : null;
    }

    /**
     * Add custom event pattern
     * @param {string} eventType - Event type
     * @param {string} patternString - Pattern string
     * @param {Array} groups - Group names
     */
    addCustomEventPattern(eventType, patternString, groups = []) {
        // Add to PatternLoader
        const patternObj = {
            pattern: patternString,
            groups: groups || this.getDefaultGroups(eventType),
            custom: true,
            description: `Runtime custom ${eventType} pattern`
        };

        this.patternLoader.addCustomPattern(this.serverType, 'events', eventType, patternObj);
        
        // Clear our cache
        const cacheKey = `${this.serverType}-events-${eventType}`;
        this.patternCache.delete(cacheKey);

        logger.debug(`Added custom ${eventType} event pattern: ${patternString}`);
    }

    /**
     * Get total pattern count
     * @returns {number} Total number of patterns
     */
    getTotalPatternCount() {
        const eventTypes = this.patternLoader.getEventTypes(this.serverType);
        return eventTypes.reduce((total, eventType) => {
            return total + this.getEventPatterns(eventType).length;
        }, 0);
    }

    /**
     * Get custom pattern count
     * @returns {number} Number of custom patterns
     */
    getCustomPatternCount() {
        const eventTypes = this.patternLoader.getEventTypes(this.serverType);
        return eventTypes.reduce((total, eventType) => {
            const patterns = this.getEventPatterns(eventType);
            const customCount = patterns.filter(p => p.custom).length;
            return total + customCount;
        }, 0);
    }

    /**
     * Update configuration
     * @param {object} newConfig - New configuration
     */
    updateConfig(newConfig) {
        const oldServerType = this.config.serverType;
        this.config = { ...this.config, ...newConfig };
        
        // Update server type if changed
        if (newConfig.serverType && newConfig.serverType !== oldServerType) {
            this.serverType = newConfig.serverType;
            this.validateServerSupport();
            this.patternCache.clear(); // Clear cache since server changed
            logger.debug(`Server type changed from ${oldServerType} to ${this.serverType}`);
        }

        logger.debug('EventPatterns configuration updated');
    }

    /**
     * Get current configuration
     * @returns {object} Current configuration
     */
    getConfig() {
        return { ...this.config };
    }

    /**
     * Test event matching (for debugging)
     * @param {string} messageText - Message to test
     * @returns {object} Test results
     */
    testEventMatching(messageText) {
        const results = {
            originalText: messageText,
            serverType: this.serverType,
            cleanedText: this.cleanMessageForMatching(messageText),
            matchedEvent: this.matchEvent(messageText),
            eventType: this.getEventType(messageText),
            isEvent: this.isGuildEvent(messageText),
            availableEventTypes: this.patternLoader.getEventTypes(this.serverType),
            totalPatterns: this.getTotalPatternCount()
        };

        if (results.matchedEvent) {
            results.matchedPattern = results.matchedEvent.patternIndex;
            results.groups = results.matchedEvent.groups;
            results.description = results.matchedEvent.description;
        }

        return results;
    }

    /**
     * Clear pattern cache
     */
    clearCache() {
        this.patternCache.clear();
        logger.debug('EventPatterns cache cleared');
    }

    /**
     * Get pattern statistics
     * @returns {object} Pattern statistics
     */
    getStatistics() {
        const eventTypes = this.patternLoader.getEventTypes(this.serverType);
        const stats = {
            serverType: this.serverType,
            eventTypes: eventTypes,
            patternCounts: {},
            totalPatterns: 0,
            customPatterns: 0
        };

        eventTypes.forEach(eventType => {
            const patterns = this.getEventPatterns(eventType);
            const customCount = patterns.filter(p => p.custom).length;
            
            stats.patternCounts[eventType] = {
                total: patterns.length,
                custom: customCount
            };
            
            stats.totalPatterns += patterns.length;
            stats.customPatterns += customCount;
        });

        return stats;
    }
}

module.exports = EventPatterns;