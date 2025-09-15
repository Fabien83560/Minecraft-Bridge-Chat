// Specific Imports
const logger = require("../../../shared/logger");
const { getPatternLoader } = require("../../../config/PatternLoader.js");

class MessagePatterns {
    constructor(config) {
        this.config = config;
        this.patternLoader = getPatternLoader();
        this.serverType = config.serverType || 'Hypixel';

        // Pattern cache for performance
        this.patternCache = new Map();
        
        // Validate server support
        this.validateServerSupport();
        
        logger.debug(`MessagePatterns initialized for server: ${this.serverType}`);
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
     * Get patterns for a specific message type
     * @param {string} messageType - Message type (guild, officer, private, party)
     * @returns {Array} Array of pattern objects
     */
    getMessagePatterns(messageType) {
        const cacheKey = `${this.serverType}-messages-${messageType}`;
        
        if (this.patternCache.has(cacheKey)) {
            return this.patternCache.get(cacheKey);
        }

        const patterns = this.patternLoader.getPatterns(this.serverType, 'messages', messageType);
        
        // Add custom patterns from configuration if any
        if (this.config.customPatterns && this.config.customPatterns[messageType]) {
            const customPatterns = this.config.customPatterns[messageType].map(patternStr => ({
                pattern: new RegExp(patternStr),
                originalPattern: patternStr,
                groups: this.getDefaultGroups(messageType),
                custom: true,
                description: `Custom ${messageType} pattern`
            }));
            patterns.push(...customPatterns);
        }

        this.patternCache.set(cacheKey, patterns);
        return patterns;
    }

    /**
     * Get system patterns
     * @returns {Array} Array of system pattern objects
     */
    getSystemPatterns() {
        const cacheKey = `${this.serverType}-system`;
        
        if (this.patternCache.has(cacheKey)) {
            return this.patternCache.get(cacheKey);
        }

        const patterns = this.patternLoader.getPatterns(this.serverType, 'system');
        this.patternCache.set(cacheKey, patterns);
        return patterns;
    }

    /**
     * Get ignore patterns
     * @returns {Array} Array of ignore pattern objects
     */
    getIgnorePatterns() {
        const cacheKey = `${this.serverType}-ignore`;
        
        if (this.patternCache.has(cacheKey)) {
            return this.patternCache.get(cacheKey);
        }

        const patterns = this.patternLoader.getPatterns(this.serverType, 'ignore');
        
        // Add custom ignore patterns from configuration if any
        if (this.config.customPatterns && this.config.customPatterns.ignore) {
            const customPatterns = this.config.customPatterns.ignore.map(patternStr => ({
                pattern: new RegExp(patternStr, 'i'),
                originalPattern: patternStr,
                custom: true,
                description: 'Custom ignore pattern'
            }));
            patterns.push(...customPatterns);
        }

        this.patternCache.set(cacheKey, patterns);
        return patterns;
    }

    /**
     * Get default groups for a message type
     * @param {string} messageType - Message type
     * @returns {Array} Default groups for the message type
     */
    getDefaultGroups(messageType) {
        const defaultGroups = {
            'guild': ['username', 'message'],
            'officer': ['username', 'message'],
            'private': ['username', 'message'],
            'party': ['username', 'message']
        };

        return defaultGroups[messageType] || [];
    }

    /**
     * Match guild message patterns
     * @param {string} messageText - Message text to match
     * @returns {object|null} Match result or null
     */
    matchGuildMessage(messageText) {
        const patterns = this.getMessagePatterns('guild');
        
        for (let i = 0; i < patterns.length; i++) {
            const patternObj = patterns[i];
            if (!patternObj || !patternObj.pattern) continue;

            const match = messageText.match(patternObj.pattern);
            if (match) {
                return this.parseMatch(match, 'guild', patternObj, i);
            }
        }
        return null;
    }

    /**
     * Match officer message patterns
     * @param {string} messageText - Message text to match
     * @returns {object|null} Match result or null
     */
    matchOfficerMessage(messageText) {
        const patterns = this.getMessagePatterns('officer');
        
        for (let i = 0; i < patterns.length; i++) {
            const patternObj = patterns[i];
            if (!patternObj || !patternObj.pattern) continue;

            const match = messageText.match(patternObj.pattern);
            if (match) {
                return this.parseMatch(match, 'officer', patternObj, i);
            }
        }
        return null;
    }

    /**
     * Match private message patterns
     * @param {string} messageText - Message text to match
     * @returns {object|null} Match result or null
     */
    matchPrivateMessage(messageText) {
        const patterns = this.getMessagePatterns('private');
        
        for (let i = 0; i < patterns.length; i++) {
            const patternObj = patterns[i];
            if (!patternObj || !patternObj.pattern) continue;

            const match = messageText.match(patternObj.pattern);
            if (match) {
                const result = this.parseMatch(match, 'private', patternObj, i);
                // Add direction from pattern configuration
                if (patternObj.direction) {
                    result.direction = patternObj.direction;
                } else {
                    // Fallback to detecting from message content
                    result.direction = match[0].toLowerCase().startsWith('from') ? 'from' : 'to';
                }
                return result;
            }
        }
        return null;
    }

    /**
     * Match party message patterns
     * @param {string} messageText - Message text to match
     * @returns {object|null} Match result or null
     */
    matchPartyMessage(messageText) {
        const patterns = this.getMessagePatterns('party');
        
        for (let i = 0; i < patterns.length; i++) {
            const patternObj = patterns[i];
            if (!patternObj || !patternObj.pattern) continue;

            const match = messageText.match(patternObj.pattern);
            if (match) {
                return this.parseMatch(match, 'party', patternObj, i);
            }
        }
        return null;
    }

    /**
     * Match system message patterns
     * @param {string} messageText - Message text to match
     * @returns {object|null} Match result or null
     */
    matchSystemMessage(messageText) {
        const patterns = this.getSystemPatterns();
        
        for (const patternObj of patterns) {
            if (!patternObj || !patternObj.pattern) continue;

            const match = messageText.match(patternObj.pattern);
            if (match) {
                return {
                    systemType: patternObj.type || 'unknown',
                    data: this.extractSystemData(match, patternObj.type || 'unknown'),
                    fullMatch: match[0],
                    originalText: messageText,
                    description: patternObj.description
                };
            }
        }
        return null;
    }

    /**
     * Check if message should be ignored
     * @param {string} messageText - Message text to check
     * @returns {boolean} Whether message should be ignored
     */
    shouldIgnore(messageText) {
        const patterns = this.getIgnorePatterns();
        
        return patterns.some(patternObj => {
            if (!patternObj || !patternObj.pattern) return false;
            return patternObj.pattern.test(messageText);
        });
    }

    /**
     * Parse message match result
     * @param {Array} match - Regex match result
     * @param {string} messageType - Type of message
     * @param {object} patternObj - Pattern object that matched
     * @param {number} patternIndex - Index of pattern
     * @returns {object} Parsed match data
     */
    parseMatch(match, messageType, patternObj, patternIndex) {
        const groups = patternObj.groups || this.getDefaultGroups(messageType);
        const result = {
            patternIndex: patternIndex,
            hasColorCodes: this.hasColorCodes(match[0]),
            description: patternObj.description,
            custom: patternObj.custom || false
        };

        // Map groups to result object
        for (let i = 0; i < groups.length && i + 1 < match.length; i++) {
            const groupName = groups[i];
            const groupValue = match[i + 1];
            
            if (groupValue !== undefined) {
                result[groupName] = groupValue;
            }
        }

        // Handle complex patterns with multiple rank groups
        if (messageType === 'guild' || messageType === 'officer') {
            // If we have rank1, rank2, use the first one as primary rank
            if (result.rank1) {
                result.rank = result.rank1;
                result.secondaryRank = result.rank2 || null;
            }
            
            // If we don't have a username but have multiple potential matches, use the best one
            if (!result.username && match.length > 2) {
                // Find the most likely username (usually the second or third match)
                for (let i = 1; i < match.length; i++) {
                    const potential = match[i];
                    if (potential && /^\w+$/.test(potential) && potential.length > 2) {
                        result.username = potential;
                        break;
                    }
                }
            }
            
            // Message is usually the last match
            if (!result.message && match.length > 1) {
                result.message = match[match.length - 1];
            }
        }

        return result;
    }

    /**
     * Extract system message data
     * @param {Array} match - Regex match result
     * @param {string} systemType - Type of system message
     * @returns {object} Extracted system data
     */
    extractSystemData(match, systemType) {
        const data = {
            type: systemType,
            fullText: match[0]
        };

        switch (systemType) {
            case 'guild_join':
            case 'guild_leave':
            case 'guild_promotion':
            case 'guild_demotion':
                if (match[1]) {
                    data.username = match[1];
                }
                break;
            
            case 'guild_online':
                // Extract online members list if present
                const onlineMatch = match[0].match(/Online Members: (.+)/);
                if (onlineMatch) {
                    data.membersList = onlineMatch[1];
                    data.members = onlineMatch[1].split(', ').map(m => m.trim());
                }
                break;
            
            case 'reward':
                // Extract coin/XP amounts
                const rewardMatch = match[0].match(/\+(\d+)/);
                if (rewardMatch) {
                    data.amount = parseInt(rewardMatch[1]);
                }
                break;

            default:
                // For other system types, try to extract any numbers or usernames
                const numberMatch = match[0].match(/(\d+)/);
                if (numberMatch) {
                    data.number = parseInt(numberMatch[1]);
                }
                
                const usernameMatch = match[0].match(/(\w{3,16})/);
                if (usernameMatch) {
                    data.possibleUsername = usernameMatch[1];
                }
                break;
        }

        return data;
    }

    /**
     * Check if text contains Minecraft color codes
     * @param {string} text - Text to check
     * @returns {boolean} Whether text has color codes
     */
    hasColorCodes(text) {
        if (!text || typeof text !== 'string') {
            return false;
        }

        const colorCodePattern = this.patternLoader.getDefaults('colorCodes').all;
        if (colorCodePattern) {
            return new RegExp(colorCodePattern).test(text);
        }
        
        // Fallback pattern
        return /§[0-9a-fklmnor]/g.test(text);
    }

    /**
     * Add custom pattern to specific type
     * @param {string} type - Pattern type (guild, officer, private, party, ignore)
     * @param {string} patternString - Pattern string
     * @param {Array} groups - Group names
     */
    addCustomPattern(type, patternString, groups = []) {
        let category = 'messages';
        let subCategory = type;

        // Handle special cases
        if (type === 'ignore') {
            category = 'ignore';
            subCategory = null;
        }

        const patternObj = {
            pattern: patternString,
            groups: groups.length > 0 ? groups : this.getDefaultGroups(type),
            custom: true,
            description: `Runtime custom ${type} pattern`
        };

        this.patternLoader.addCustomPattern(this.serverType, category, subCategory, patternObj);
        
        // Clear our cache
        const cacheKey = subCategory ? 
            `${this.serverType}-${category}-${subCategory}` : 
            `${this.serverType}-${category}`;
        this.patternCache.delete(cacheKey);

        logger.debug(`Added custom ${type} pattern: ${patternString}`);
    }

    /**
     * Test a message against all patterns (for debugging)
     * @param {string} messageText - Message to test
     * @returns {object} Test results
     */
    testMessage(messageText) {
        const results = {
            originalText: messageText,
            serverType: this.serverType,
            matches: {},
            shouldIgnore: this.shouldIgnore(messageText),
            availableMessageTypes: this.patternLoader.getMessageTypes(this.serverType)
        };

        // Test all message pattern types
        const messageTypes = ['guild', 'officer', 'private', 'party'];
        
        messageTypes.forEach(messageType => {
            const match = this[`match${messageType.charAt(0).toUpperCase() + messageType.slice(1)}Message`](messageText);
            if (match) {
                results.matches[messageType] = match;
            }
        });

        // Test system patterns
        const systemMatch = this.matchSystemMessage(messageText);
        if (systemMatch) {
            results.matches.system = systemMatch;
        }

        results.matchCount = Object.keys(results.matches).length;
        results.hasMultipleMatches = results.matchCount > 1;

        return results;
    }

    /**
     * Get pattern statistics
     * @returns {object} Pattern statistics
     */
    getStatistics() {
        const messageTypes = this.patternLoader.getMessageTypes(this.serverType);
        const stats = {
            serverType: this.serverType,
            messageTypes: messageTypes,
            patternCounts: {},
            totalPatterns: 0,
            customPatterns: 0
        };

        // Count message patterns
        messageTypes.forEach(messageType => {
            const patterns = this.getMessagePatterns(messageType);
            const customCount = patterns.filter(p => p.custom).length;
            
            stats.patternCounts[messageType] = {
                total: patterns.length,
                custom: customCount
            };
            
            stats.totalPatterns += patterns.length;
            stats.customPatterns += customCount;
        });

        // Count system patterns
        const systemPatterns = this.getSystemPatterns();
        stats.patternCounts.system = {
            total: systemPatterns.length,
            custom: systemPatterns.filter(p => p.custom).length
        };
        stats.totalPatterns += systemPatterns.length;
        stats.customPatterns += systemPatterns.filter(p => p.custom).length;

        // Count ignore patterns
        const ignorePatterns = this.getIgnorePatterns();
        stats.patternCounts.ignore = {
            total: ignorePatterns.length,
            custom: ignorePatterns.filter(p => p.custom).length
        };
        stats.totalPatterns += ignorePatterns.length;
        stats.customPatterns += ignorePatterns.filter(p => p.custom).length;

        return stats;
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

        logger.debug('MessagePatterns configuration updated');
    }

    /**
     * Get current configuration
     * @returns {object} Current configuration
     */
    getConfig() {
        return { ...this.config };
    }

    /**
     * Clear pattern cache
     */
    clearCache() {
        this.patternCache.clear();
        logger.debug('MessagePatterns cache cleared');
    }
}

module.exports = MessagePatterns;