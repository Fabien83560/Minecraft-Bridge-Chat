// Specific Imports
const logger = require("../../../shared/logger")

class EventPatterns {
    constructor(config) {
        this.config = config;

        this.joinPatterns = [];
        this.leavePatterns = [];
        this.kickPatterns = [];
        this.promotePatterns = [];
        this.demotePatterns = [];
        this.invitePatterns = [];
        this.onlinePatterns = [];
        this.levelPatterns = [];
        this.motdPatterns = [];
        this.miscPatterns = [];

        this.initializeEventPatterns();
    }

    initializeEventPatterns() {
        // Guild member events
        this.joinPatterns = [
            // Standard join messages
            { pattern: /(\w+) joined the guild!/, groups: ['username'] },
            { pattern: /(\w+) has joined the guild/, groups: ['username'] },
            { pattern: /Guild member (\w+) joined/, groups: ['username'] },
            { pattern: /Welcome (\w+) to the guild!/, groups: ['username'] },
            
            // With color codes
            { pattern: /§a(\w+) joined the guild!§r/, groups: ['username'] },
            { pattern: /§2Guild member §r(\w+)§r joined/, groups: ['username'] },
            
            // With ranks/prefixes
            { pattern: /\[([^\]]+)\] (\w+) joined the guild!/, groups: ['rank', 'username'] },
            { pattern: /(\w+) \(([^)]+)\) joined the guild!/, groups: ['username', 'rank'] }
        ];

        this.leavePatterns = [
            // Standard leave messages
            { pattern: /(\w+) left the guild/, groups: ['username'] },
            { pattern: /(\w+) has left the guild/, groups: ['username'] },
            { pattern: /Guild member (\w+) left/, groups: ['username'] },
            
            // With color codes
            { pattern: /§c(\w+) left the guild§r/, groups: ['username'] },
            { pattern: /§4Guild member §r(\w+)§r left/, groups: ['username'] },
            
            // With reasons
            { pattern: /(\w+) left the guild \(([^)]+)\)/, groups: ['username', 'reason'] }
        ];

        this.kickPatterns = [
            // Standard kick messages
            { pattern: /(\w+) was kicked from the guild by (\w+)/, groups: ['username', 'kicker'] },
            { pattern: /(\w+) was removed from the guild by (\w+)/, groups: ['username', 'kicker'] },
            { pattern: /(\w+) was kicked from the guild/, groups: ['username'] },
            
            // With color codes
            { pattern: /§c(\w+) was kicked from the guild by §r(\w+)§r/, groups: ['username', 'kicker'] },
            
            // With reasons
            { pattern: /(\w+) was kicked from the guild by (\w+): (.+)/, groups: ['username', 'kicker', 'reason'] }
        ];

        this.promotePatterns = [
            // Standard promotion messages
            { pattern: /(\w+) was promoted from (.+) to (.+)/, groups: ['username', 'fromRank', 'toRank'] },
            { pattern: /(\w+) was promoted to (.+)/, groups: ['username', 'toRank'] },
            { pattern: /(\w+) is now (.+) in the guild/, groups: ['username', 'toRank'] },
            
            // With color codes
            { pattern: /§a(\w+) was promoted to §r(.+)§r/, groups: ['username', 'toRank'] },
            { pattern: /§2(\w+) is now §r(.+)§r in the guild/, groups: ['username', 'toRank'] },
            
            // With promoter
            { pattern: /(\w+) promoted (\w+) to (.+)/, groups: ['promoter', 'username', 'toRank'] }
        ];

        this.demotePatterns = [
            // Standard demotion messages
            { pattern: /(\w+) was demoted from (.+) to (.+)/, groups: ['username', 'fromRank', 'toRank'] },
            { pattern: /(\w+) was demoted to (.+)/, groups: ['username', 'toRank'] },
            
            // With color codes
            { pattern: /§c(\w+) was demoted to §r(.+)§r/, groups: ['username', 'toRank'] },
            
            // With demoter
            { pattern: /(\w+) demoted (\w+) to (.+)/, groups: ['demoter', 'username', 'toRank'] }
        ];

        this.invitePatterns = [
            // Standard invite messages
            { pattern: /(\w+) invited (\w+) to the guild/, groups: ['inviter', 'invited'] },
            { pattern: /(\w+) has invited (\w+) to join the guild/, groups: ['inviter', 'invited'] },
            
            // With color codes
            { pattern: /§b(\w+) invited §r(\w+)§r to the guild/, groups: ['inviter', 'invited'] },
            
            // Guild invite accepted
            { pattern: /(\w+) accepted (\w+)'s guild invitation/, groups: ['invited', 'inviter'] }
        ];

        this.onlinePatterns = [
            // Standard online messages
            { pattern: /Online Members: (.+)/, groups: ['membersList'] },
            { pattern: /Guild Members Online \((\d+)\): (.+)/, groups: ['count', 'membersList'] },
            { pattern: /(\d+) guild members online: (.+)/, groups: ['count', 'membersList'] },
            
            // With color codes
            { pattern: /§aOnline Members§r: (.+)/, groups: ['membersList'] },
            { pattern: /§2Guild Members Online \((\d+)\)§r: (.+)/, groups: ['count', 'membersList'] }
        ];

        this.levelPatterns = [
            // Guild level up messages
            { pattern: /The Guild has reached Level (\d+)!/, groups: ['level'] },
            { pattern: /Guild leveled up to Level (\d+)!/, groups: ['level'] },
            { pattern: /Your guild is now level (\d+)!/, groups: ['level'] },
            
            // With color codes
            { pattern: /§6The Guild has reached Level (\d+)!§r/, groups: ['level'] },
            { pattern: /§eGuild leveled up to Level (\d+)!§r/, groups: ['level'] }
        ];

        this.motdPatterns = [
            // Message of the day changes
            { pattern: /(\w+) changed the guild MOTD to: (.+)/, groups: ['changer', 'motd'] },
            { pattern: /Guild MOTD updated by (\w+): (.+)/, groups: ['changer', 'motd'] },
            
            // With color codes
            { pattern: /§b(\w+) changed the guild MOTD to§r: (.+)/, groups: ['changer', 'motd'] }
        ];

        this.miscPatterns = [
            // Guild tag changes
            { pattern: /(\w+) changed the guild tag to \[([^\]]+)\]/, groups: ['changer', 'newTag'] },
            
            // Guild name changes
            { pattern: /(\w+) renamed the guild to (.+)/, groups: ['changer', 'newName'] },
            
            // Guild description changes
            { pattern: /(\w+) updated the guild description/, groups: ['changer'] },
            
            // Guild settings changes
            { pattern: /(\w+) changed guild settings/, groups: ['changer'] }
        ];

        // Add custom patterns from configuration
        this.addCustomPatterns();
    }

    /**
     * Add custom patterns from configuration
     */
    addCustomPatterns() {
        const custom = this.config.customEventPatterns;
        
        if (custom.join) {
            this.joinPatterns.push(...custom.join.map(p => ({ pattern: p, groups: ['username'], custom: true })));
        }
        if (custom.leave) {
            this.leavePatterns.push(...custom.leave.map(p => ({ pattern: p, groups: ['username'], custom: true })));
        }
        if (custom.kick) {
            this.kickPatterns.push(...custom.kick.map(p => ({ pattern: p, groups: ['username', 'kicker'], custom: true })));
        }
        if (custom.promote) {
            this.promotePatterns.push(...custom.promote.map(p => ({ pattern: p, groups: ['username', 'toRank'], custom: true })));
        }
        if (custom.demote) {
            this.demotePatterns.push(...custom.demote.map(p => ({ pattern: p, groups: ['username', 'toRank'], custom: true })));
        }
    }

    /**
     * Match an event against all patterns
     * @param {string} messageText - Message text to match
     * @returns {object|null} Matched event or null
     */
    matchEvent(messageText) {
        // Clean message text
        const cleanText = this.cleanMessageForMatching(messageText);
        
        // Try each event type
        const eventTypes = [
            { type: 'join', patterns: this.joinPatterns },
            { type: 'leave', patterns: this.leavePatterns },
            { type: 'kick', patterns: this.kickPatterns },
            { type: 'promote', patterns: this.promotePatterns },
            { type: 'demote', patterns: this.demotePatterns },
            { type: 'invite', patterns: this.invitePatterns },
            { type: 'online', patterns: this.onlinePatterns },
            { type: 'level', patterns: this.levelPatterns },
            { type: 'motd', patterns: this.motdPatterns },
            { type: 'misc', patterns: this.miscPatterns }
        ];

        for (const eventType of eventTypes) {
            for (let i = 0; i < eventType.patterns.length; i++) {
                const patternObj = eventType.patterns[i];
                const match = cleanText.match(patternObj.pattern);
                
                if (match) {
                    return this.parseEventMatch(match, eventType.type, patternObj, i);
                }
            }
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
            groups: patternObj.groups || []
        };

        // Map match groups to named properties based on event type
        switch (eventType) {
            case 'join':
                eventData.username = match[1];
                if (match[2] && patternObj.groups.includes('rank')) {
                    eventData.rank = match[2];
                }
                break;

            case 'leave':
                eventData.username = match[1];
                if (match[2]) {
                    eventData.reason = match[2];
                }
                break;

            case 'kick':
                eventData.username = match[1];
                if (match[2]) {
                    eventData.kickedBy = match[2];
                }
                if (match[3]) {
                    eventData.reason = match[3];
                }
                break;

            case 'promote':
                if (patternObj.groups[0] === 'promoter') {
                    eventData.promoter = match[1];
                    eventData.username = match[2];
                    eventData.toRank = match[3];
                } else {
                    eventData.username = match[1];
                    eventData.fromRank = match[2];
                    eventData.toRank = match[3] || match[2];
                }
                break;

            case 'demote':
                if (patternObj.groups[0] === 'demoter') {
                    eventData.demoter = match[1];
                    eventData.username = match[2];
                    eventData.toRank = match[3];
                } else {
                    eventData.username = match[1];
                    eventData.fromRank = match[2];
                    eventData.toRank = match[3] || match[2];
                }
                break;

            case 'invite':
                eventData.inviter = match[1];
                eventData.invited = match[2];
                break;

            case 'online':
                if (match[2]) {
                    eventData.count = parseInt(match[1]);
                    eventData.membersList = match[2];
                } else {
                    eventData.membersList = match[1];
                    eventData.count = this.countOnlineMembers(match[1]);
                }
                eventData.members = this.parseOnlineMembers(eventData.membersList);
                break;

            case 'level':
                eventData.level = parseInt(match[1]);
                break;

            case 'motd':
                eventData.changer = match[1];
                eventData.motd = match[2];
                break;

            case 'misc':
                eventData.changer = match[1];
                if (match[2]) {
                    if (patternObj.pattern.toString().includes('tag')) {
                        eventData.newTag = match[2];
                    } else if (patternObj.pattern.toString().includes('name')) {
                        eventData.newName = match[2];
                    }
                }
                break;
        }

        return eventData;
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
            cleaned = cleaned.replace(/§[0-9a-fklmnor]/g, '');
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
     * Count online members from list
     * @param {string} membersList - String of online members
     * @returns {number} Number of online members
     */
    countOnlineMembers(membersList) {
        const members = this.parseOnlineMembers(membersList);
        return members.length;
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
     * Get event type for message
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
     * @param {RegExp} pattern - Pattern regex
     * @param {Array} groups - Group names
     */
    addCustomEventPattern(eventType, pattern, groups = []) {
        if (!(pattern instanceof RegExp)) {
            throw new Error('Pattern must be a RegExp object');
        }

        const patternObj = {
            pattern: pattern,
            groups: groups,
            custom: true
        };

        switch (eventType) {
            case 'join':
                this.joinPatterns.push(patternObj);
                break;
            case 'leave':
                this.leavePatterns.push(patternObj);
                break;
            case 'kick':
                this.kickPatterns.push(patternObj);
                break;
            case 'promote':
                this.promotePatterns.push(patternObj);
                break;
            case 'demote':
                this.demotePatterns.push(patternObj);
                break;
            case 'invite':
                this.invitePatterns.push(patternObj);
                break;
            case 'online':
                this.onlinePatterns.push(patternObj);
                break;
            case 'level':
                this.levelPatterns.push(patternObj);
                break;
            case 'motd':
                this.motdPatterns.push(patternObj);
                break;
            case 'misc':
                this.miscPatterns.push(patternObj);
                break;
            default:
                throw new Error(`Unknown event type: ${eventType}`);
        }

        logger.debug(`Added custom ${eventType} event pattern: ${pattern}`);
    }

    /**
     * Get total pattern count
     * @returns {number} Total number of patterns
     */
    getTotalPatternCount() {
        return this.joinPatterns.length +
               this.leavePatterns.length +
               this.kickPatterns.length +
               this.promotePatterns.length +
               this.demotePatterns.length +
               this.invitePatterns.length +
               this.onlinePatterns.length +
               this.levelPatterns.length +
               this.motdPatterns.length +
               this.miscPatterns.length;
    }

    /**
     * Get custom pattern count
     * @returns {number} Number of custom patterns
     */
    getCustomPatternCount() {
        const allPatterns = [
            ...this.joinPatterns,
            ...this.leavePatterns,
            ...this.kickPatterns,
            ...this.promotePatterns,
            ...this.demotePatterns,
            ...this.invitePatterns,
            ...this.onlinePatterns,
            ...this.levelPatterns,
            ...this.motdPatterns,
            ...this.miscPatterns
        ];

        return allPatterns.filter(p => p.custom).length;
    }

    /**
     * Update configuration
     * @param {object} newConfig - New configuration
     */
    updateConfig(newConfig) {
        const oldServerType = this.config.serverType;
        this.config = { ...this.config, ...newConfig };

        // Reinitialize patterns if server type changed
        if (oldServerType !== this.config.serverType) {
            logger.debug(`Server type changed from ${oldServerType} to ${this.config.serverType}`);
            this.initializeEventPatterns();
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
            cleanedText: this.cleanMessageForMatching(messageText),
            matchedEvent: this.matchEvent(messageText),
            eventType: this.getEventType(messageText),
            isEvent: this.isGuildEvent(messageText)
        };

        if (results.matchedEvent) {
            results.matchedPattern = results.matchedEvent.patternIndex;
            results.groups = results.matchedEvent.groups;
        }

        return results;
    }
}

module.exports = EventPatterns;