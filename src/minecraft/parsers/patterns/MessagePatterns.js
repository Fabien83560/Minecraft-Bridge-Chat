// Specific Imports
const logger = require("../../../shared/logger")

class MessagePatterns {
    constructor(config) {
        this.config = config;

        this.guildPatterns = [];
        this.officerPatterns = [];
        this.privatePatterns = [];
        this.partyPatterns = [];
        this.systemPatterns = [];
        this.ignorePatterns = [];

        this.initializePatterns();
    }

    /**
     * Initialize all message patterns based on server type
     */
    initializePatterns() {
        // Guild chat patterns (with and without color codes) - UPDATED to exclude join/left events
        this.guildPatterns = [
            // Hypixel standard formats - exclude join/left messages
            /^Guild > (?!.+(?:joined|left)\.$)(\w+): (.+)$/,
            /^Guild > (?!.+(?:joined|left)\.$)\[.*?\] (\w+) \[.*?\]: (.+)$/,
            /^Guild > (?!.+(?:joined|left)\.$)\[.*?\] (\w+): (.+)$/,
            /^G > (?!.+(?:joined|left)\.$)(\w+): (.+)$/,
            
            // With color codes (§) - exclude join/left messages
            /^§2Guild > §r(?!.+(?:joined|left)\.$)(\w+)§r: (.+)$/,
            /^§aGuild > §r(?!.+(?:joined|left)\.$)(\w+)§r: (.+)$/,
            /^§2G > §r(?!.+(?:joined|left)\.$)(\w+)§r: (.+)$/,
            /^§aG > §r(?!.+(?:joined|left)\.$)(\w+)§r: (.+)$/,
            
            // With ranks - exclude join/left messages
            /^Guild > (?!.+(?:joined|left)\.$)\[([^\]]+)\] (\w+) \[([^\]]+)\]: (.+)$/,
            /^§2Guild > §r(?!.+(?:joined|left)\.$)\[([^\]§]+)§r\] §r(\w+)§r \[([^\]§]+)§r\]: (.+)$/,
            
            // Alternative formats
            /^Guild Chat > (\w+): (.+)$/,
            /^§2Guild Chat > §r(\w+)§r: (.+)$/
        ];

        // Officer chat patterns
        this.officerPatterns = [
            // Standard formats
            /^Officer > (\w+): (.+)$/,
            /^Officer > \[.*?\] (\w+) \[.*?\]: (.+)$/,
            /^Officer > \[.*?\] (\w+): (.+)$/,
            /^O > (\w+): (.+)$/,
            
            // With color codes
            /^§3Officer > §r(\w+)§r: (.+)$/,
            /^§3O > §r(\w+)§r: (.+)$/,
            /^§bOfficer > §r(\w+)§r: (.+)$/,
            
            // With ranks
            /^Officer > \[([^\]]+)\] (\w+) \[([^\]]+)\]: (.+)$/,
            /^§3Officer > §r\[([^\]§]+)§r\] §r(\w+)§r \[([^\]§]+)§r\]: (.+)$/
        ];

        // Private message patterns
        this.privatePatterns = [
            // From messages
            /^From (\w+): (.+)$/,
            /^§dFrom (\w+)§r: (.+)$/,
            /^§5From (\w+)§r: (.+)$/,
            
            // To messages  
            /^To (\w+): (.+)$/,
            /^§dTo (\w+)§r: (.+)$/,
            /^§5To (\w+)§r: (.+)$/,
            
            // With ranks
            /^From \[([^\]]+)\] (\w+): (.+)$/,
            /^To \[([^\]]+)\] (\w+): (.+)$/
        ];

        // Party message patterns
        this.partyPatterns = [
            /^Party > (\w+): (.+)$/,
            /^Party > \[.*?\] (\w+): (.+)$/,
            /^P > (\w+): (.+)$/,
            /^§9Party > §r(\w+)§r: (.+)$/,
            /^§9P > §r(\w+)§r: (.+)$/
        ];

        // System message patterns
        this.systemPatterns = [
            // Game notifications
            { pattern: /^(?:You are now|You have been|Welcome to|Game starting)/, type: 'game_notification' },
            { pattern: /^(?:WINNER|FINAL KILL|Respawning in)/, type: 'game_result' },
            { pattern: /^(?:\+\d+ coins|You earned|Level up)/, type: 'reward' },
            { pattern: /^(?:Mystery Box|Daily Reward|Network Level)/, type: 'daily_reward' },
            
            // Server messages
            { pattern: /^Server restart in/, type: 'server_restart' },
            { pattern: /^You have been moved to/, type: 'server_move' },
            { pattern: /^Connection throttled/, type: 'connection_issue' },
            
            // Guild system messages (these should be handled as events now, but keeping for fallback)
            { pattern: /^(\w+) joined the guild!/, type: 'guild_join' },
            { pattern: /^(\w+) left the guild/, type: 'guild_leave' },
            { pattern: /^(\w+) was promoted/, type: 'guild_promotion' },
            { pattern: /^(\w+) was demoted/, type: 'guild_demotion' },
            { pattern: /^Online Members:/, type: 'guild_online' }
        ];

        // Messages to ignore (spam/advertisements)
        this.ignorePatterns = [
            // Game advertisements and spam
            /^\[[\w\+]+\] [\w_]+: .*(?:join|game|party|lobby)/i,
            /^[\w_]+: .*(?:www\.|discord\.gg|\.com|\.net|\.org)/i,
            /^[\w_]+: .*(?:youtube|twitch|stream|video)/i,
            
            // Common spam phrases
            /^[\w_]+: .*(?:sub|subscribe|follow|like|click)/i,
            /^[\w_]+: .*(?:free|giveaway|win|prize)/i,
            /^[\w_]+: .*(?:hack|cheat|exploit)/i,
            
            // Hypixel specific spam
            /^([\w_]+): .*(?:coins|gems|skyblock|sb)/i,
            /^([\w_]+): .*(?:carrying|boost|service)/i,
            
            // Friend/Guild advertisements
            /^[\w_]+: .*(?:friend request|guild invite)/i,
            /^[\w_]+: .*(?:looking for guild|lfg|recruiting)/i,
            
            // Auto-messages and bots
            /^Bot>/,
            /^([\w_]+): \[BOT\]/,
            /^[\w_]+: .*(?:automatically|bot|script)/i
        ];

        // Custom patterns from configuration
        if (this.config.customPatterns.guild) {
            this.guildPatterns.push(...this.config.customPatterns.guild);
        }
        if (this.config.customPatterns.officer) {
            this.officerPatterns.push(...this.config.customPatterns.officer);
        }
        if (this.config.customPatterns.ignore) {
            this.ignorePatterns.push(...this.config.customPatterns.ignore);
        }
    }

    /**
     * Match guild message patterns
     * @param {string} messageText - Message text to match
     * @returns {object|null} Match result or null
     */
    matchGuildMessage(messageText) {
        for (let i = 0; i < this.guildPatterns.length; i++) {
            const pattern = this.guildPatterns[i];
            const match = messageText.match(pattern);
            
            if (match) {
                return this.parseGuildMatch(match, i);
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
        for (let i = 0; i < this.officerPatterns.length; i++) {
            const pattern = this.officerPatterns[i];
            const match = messageText.match(pattern);
            
            if (match) {
                return this.parseOfficerMatch(match, i);
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
        for (let i = 0; i < this.privatePatterns.length; i++) {
            const pattern = this.privatePatterns[i];
            const match = messageText.match(pattern);
            
            if (match) {
                return this.parsePrivateMatch(match, i);
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
        for (let i = 0; i < this.partyPatterns.length; i++) {
            const pattern = this.partyPatterns[i];
            const match = messageText.match(pattern);
            
            if (match) {
                return this.parsePartyMatch(match, i);
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
        for (const systemPattern of this.systemPatterns) {
            const match = messageText.match(systemPattern.pattern);
            
            if (match) {
                return {
                    systemType: systemPattern.type,
                    data: this.extractSystemData(match, systemPattern.type),
                    fullMatch: match[0],
                    originalText: messageText
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
        return this.ignorePatterns.some(pattern => pattern.test(messageText));
    }

    // ==================== MATCH PARSING METHODS ====================

    /**
     * Parse guild message match
     * @param {Array} match - Regex match result
     * @param {number} patternIndex - Index of matched pattern
     * @returns {object} Parsed match data
     */
    parseGuildMatch(match, patternIndex) {
        // Different patterns have different group structures
        if (match.length === 3) {
            // Simple format: Guild > username: message
            return {
                username: match[1],
                message: match[2],
                rank: null,
                patternIndex: patternIndex,
                hasColorCodes: this.hasColorCodes(match[0])
            };
        } else if (match.length === 4) {
            // Format with rank: Guild > [rank] username: message
            return {
                username: match[2],
                message: match[3],
                rank: match[1],
                patternIndex: patternIndex,
                hasColorCodes: this.hasColorCodes(match[0])
            };
        } else if (match.length === 5) {
            // Complex format: Guild > [prefix] username [suffix]: message
            return {
                username: match[2],
                message: match[4],
                rank: match[1],
                suffix: match[3],
                patternIndex: patternIndex,
                hasColorCodes: this.hasColorCodes(match[0])
            };
        }
        
        // Fallback
        return {
            username: match[1] || 'Unknown',
            message: match[match.length - 1] || '',
            rank: null,
            patternIndex: patternIndex,
            hasColorCodes: this.hasColorCodes(match[0])
        };
    }

    /**
     * Parse officer message match
     * @param {Array} match - Regex match result
     * @param {number} patternIndex - Index of matched pattern
     * @returns {object} Parsed match data
     */
    parseOfficerMatch(match, patternIndex) {
        // Similar structure to guild messages
        if (match.length === 3) {
            return {
                username: match[1],
                message: match[2],
                rank: null,
                patternIndex: patternIndex,
                hasColorCodes: this.hasColorCodes(match[0])
            };
        } else if (match.length >= 4) {
            return {
                username: match[2] || match[1],
                message: match[match.length - 1],
                rank: match[1],
                patternIndex: patternIndex,
                hasColorCodes: this.hasColorCodes(match[0])
            };
        }
        
        return {
            username: match[1] || 'Unknown',
            message: match[match.length - 1] || '',
            rank: null,
            patternIndex: patternIndex,
            hasColorCodes: this.hasColorCodes(match[0])
        };
    }

    /**
     * Parse private message match
     * @param {Array} match - Regex match result
     * @param {number} patternIndex - Index of matched pattern
     * @returns {object} Parsed match data
     */
    parsePrivateMatch(match, patternIndex) {
        const direction = match[0].toLowerCase().startsWith('from') ? 'from' : 'to';
        
        if (match.length === 3) {
            return {
                username: match[1],
                message: match[2],
                direction: direction,
                rank: null,
                patternIndex: patternIndex
            };
        } else if (match.length === 4) {
            return {
                username: match[2],
                message: match[3],
                direction: direction,
                rank: match[1],
                patternIndex: patternIndex
            };
        }
        
        return {
            username: match[1] || 'Unknown',
            message: match[match.length - 1] || '',
            direction: direction,
            rank: null,
            patternIndex: patternIndex
        };
    }

    /**
     * Parse party message match
     * @param {Array} match - Regex match result
     * @param {number} patternIndex - Index of matched pattern
     * @returns {object} Parsed match data
     */
    parsePartyMatch(match, patternIndex) {
        return {
            username: match[1] || 'Unknown',
            message: match[match.length - 1] || '',
            rank: match.length > 3 ? match[1] : null,
            patternIndex: patternIndex,
            hasColorCodes: this.hasColorCodes(match[0])
        };
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
                data.username = match[1];
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
        }

        return data;
    }

    // ==================== UTILITY METHODS ====================

    /**
     * Check if text contains Minecraft color codes
     * @param {string} text - Text to check
     * @returns {boolean} Whether text has color codes
     */
    hasColorCodes(text) {
        return /§[0-9a-fklmnor]/g.test(text);
    }

    /**
     * Add custom pattern to specific type
     * @param {string} type - Pattern type (guild, officer, private, party, ignore)
     * @param {RegExp} pattern - Pattern to add
     */
    addCustomPattern(type, pattern) {
        if (!(pattern instanceof RegExp)) {
            throw new Error('Pattern must be a RegExp object');
        }

        switch (type) {
            case 'guild':
                this.guildPatterns.push(pattern);
                break;
            case 'officer':
                this.officerPatterns.push(pattern);
                break;
            case 'private':
                this.privatePatterns.push(pattern);
                break;
            case 'party':
                this.partyPatterns.push(pattern);
                break;
            case 'ignore':
                this.ignorePatterns.push(pattern);
                break;
            default:
                throw new Error(`Unknown pattern type: ${type}`);
        }

        logger.debug(`Added custom ${type} pattern: ${pattern}`);
    }

    /**
     * Test a message against all patterns (for debugging)
     * @param {string} messageText - Message to test
     * @returns {object} Test results
     */
    testMessage(messageText) {
        const results = {
            originalText: messageText,
            matches: {},
            shouldIgnore: this.shouldIgnore(messageText)
        };

        // Test all pattern types
        const guildMatch = this.matchGuildMessage(messageText);
        if (guildMatch) results.matches.guild = guildMatch;

        const officerMatch = this.matchOfficerMessage(messageText);
        if (officerMatch) results.matches.officer = officerMatch;

        const privateMatch = this.matchPrivateMessage(messageText);
        if (privateMatch) results.matches.private = privateMatch;

        const partyMatch = this.matchPartyMessage(messageText);
        if (partyMatch) results.matches.party = partyMatch;

        const systemMatch = this.matchSystemMessage(messageText);
        if (systemMatch) results.matches.system = systemMatch;

        results.matchCount = Object.keys(results.matches).length;
        results.hasMultipleMatches = results.matchCount > 1;

        return results;
    }
}

module.exports = MessagePatterns;