// Specific Imports
const logger = require("../../shared/logger");
const { getPatternLoader } = require("../../../config/PatternLoader.js");

class HypixelStrategy {
    constructor() {
        this.name = "HypixelStrategy";
        this.serverName = "Hypixel";
        this.limboDelay = 3000;
        
        this.patternLoader = getPatternLoader();
        
        // Cache for detection patterns
        this.detectionCache = new Map();
        
        logger.debug(`${this.name} initialized with PatternLoader`);
    }

    /**
     * Get detection patterns for a specific type
     * @param {string} type - Detection type (guildChat, officerChat, guildEvent, guildSystem)
     * @returns {Array} Array of detection pattern objects
     */
    getDetectionPatterns(type) {
        if (this.detectionCache.has(type)) {
            return this.detectionCache.get(type);
        }

        const patterns = this.patternLoader.getDetectionPatterns(this.serverName, type);
        this.detectionCache.set(type, patterns);
        
        logger.debug(`Loaded ${patterns.length} detection patterns for ${type}`);
        return patterns;
    }

    /**
     * Test message against detection patterns
     * @param {string} messageText - Message text to test
     * @param {string} type - Detection type
     * @returns {boolean} Whether message matches any pattern
     */
    testDetectionPatterns(messageText, type) {
        const patterns = this.getDetectionPatterns(type);
        
        return patterns.some(patternObj => {
            if (!patternObj || !patternObj.pattern) return false;
            return patternObj.pattern.test(messageText);
        });
    }

    async onConnect(bot, guildConfig) {
        logger.minecraft(`🏰 Hypixel connection strategy for ${guildConfig.name}`);
        
        // Wait for connection to stabilize
        await this.wait(this.limboDelay);
        
        // Change Hypixel Language to detect all messages
        await this.changeLanguage(bot, guildConfig);

        // Go to limbo to avoid disconnections
        await this.goToLimbo(bot, guildConfig);
    }

    async onReconnect(bot, guildConfig) {
        logger.minecraft(`🔄 Hypixel reconnection strategy for ${guildConfig.name}`);
        
        // Wait longer after reconnection
        await this.wait(this.limboDelay);

        // Change Hypixel Language to detect all messages
        await this.changeLanguage(bot, guildConfig);

        // Always return to limbo after reconnection
        await this.goToLimbo(bot, guildConfig);
    }

    async changeLanguage(bot, guildConfig, retryCount = 0) {
        try {
            logger.minecraft(`🌌 Change Hypixel Language to English for ${guildConfig.name}`);

            bot.chat(`/language English`);

            await this.wait(1000);

            logger.minecraft(`✅ Successfully change Hypixel Language to English`);
        } catch (error) {
            if (retryCount < 3) {
                logger.minecraft(`⚠️ Failed to switch Hypixel Language, retrying... (${retryCount + 1}/3)`);
                await this.wait(1000);
                return this.changeLanguage(bot, guildConfig, retryCount + 1);
            } else {
                logger.logError(error, `Failed to switch Hypixel Language for ${guildConfig.name} after 3 retries`);
                // No throw error
            }
        }
    }

    async goToLimbo(bot, guildConfig, retryCount = 0) {
        try {
            logger.minecraft(`🌌 Going to limbo for ${guildConfig.name}...`);
            
            // Send limbo command
            bot.chat('/limbo');
            
            // Wait for confirmation
            await this.wait(this.limboDelay);
            
            logger.minecraft(`✅ Successfully went to limbo for ${guildConfig.name}`);
            
        } catch (error) {
            if (retryCount < 3) {
                logger.minecraft(`⚠️ Failed to go to limbo, retrying... (${retryCount + 1}/3)`);
                await this.wait(this.limboDelay);
                return this.goToLimbo(bot, guildConfig, retryCount + 1);
            } else {
                logger.logError(error, `Failed to go to limbo for ${guildConfig.name} after 3 retries`);
                throw error;
            }
        }
    }

    async onGuildJoin(bot, guildConfig) {
        // After joining a guild, stay in limbo
        logger.minecraft(`🏰 Guild joined, staying in limbo for ${guildConfig.name}`);
        await this.wait(this.limboDelay);
        await this.goToLimbo(bot, guildConfig);
    }

    /**
     * Main message handler for Hypixel strategy
     * @param {object} bot - Mineflayer bot instance
     * @param {object} message - Raw message from Minecraft
     * @param {object} guildConfig - Guild configuration
     * @returns {object|null} Processed guild message or null if not a guild message
     */
    async onMessage(bot, message, guildConfig) {
        const messageText = message.toString();

        // Check if this is a guild-related message using detection patterns
        const guildMessageResult = this.processGuildMessage(messageText, guildConfig);
        
        if (guildMessageResult) {
            // Log all guild messages with [GUILD] prefix
            logger.bridge(`[GUILD] [${guildConfig.name}] ${guildMessageResult.type}: ${messageText}`);
            
            return guildMessageResult;
        }

        // Not a guild message, ignore
        return null;
    }

    /**
     * Process and classify guild messages using PatternLoader
     * @param {string} messageText - Raw message text
     * @param {object} guildConfig - Guild configuration
     * @returns {object|null} Guild message data or null
     */
    processGuildMessage(messageText, guildConfig) {
        // Guild Chat Messages - use detection patterns
        if (this.isGuildChatMessage(messageText)) {
            return {
                type: 'GUILD_CHAT',
                category: 'chat',
                subtype: 'guild',
                raw: messageText,
                isGuildRelated: true
            };
        }

        // Officer Chat Messages - use detection patterns
        if (this.isOfficerChatMessage(messageText)) {
            return {
                type: 'OFFICER_CHAT',
                category: 'chat',
                subtype: 'officer',
                raw: messageText,
                isGuildRelated: true
            };
        }

        // Guild Events - use detection patterns
        if (this.isGuildEventMessage(messageText)) {
            return {
                type: 'GUILD_EVENT',
                category: 'event',
                subtype: this.getGuildEventType(messageText),
                raw: messageText,
                isGuildRelated: true
            };
        }

        // Guild System Messages - use detection patterns
        if (this.isGuildSystemMessage(messageText)) {
            return {
                type: 'GUILD_SYSTEM',
                category: 'system',
                subtype: this.getGuildSystemType(messageText),
                raw: messageText,
                isGuildRelated: true
            };
        }

        return null;
    }

    /**
     * Check if message is guild chat using detection patterns
     * @param {string} message - Message text
     * @returns {boolean} Whether message is guild chat
     */
    isGuildChatMessage(message) {
        return this.testDetectionPatterns(message, 'guildChat');
    }

    /**
     * Check if message is officer chat using detection patterns
     * @param {string} message - Message text
     * @returns {boolean} Whether message is officer chat
     */
    isOfficerChatMessage(message) {
        return this.testDetectionPatterns(message, 'officerChat');
    }

    /**
     * Check if message is a guild event using detection patterns
     * @param {string} message - Message text
     * @returns {boolean} Whether message is guild event
     */
    isGuildEventMessage(message) {
        return this.testDetectionPatterns(message, 'guildEvent');
    }

    /**
     * Check if message is guild system message using detection patterns
     * @param {string} message - Message text
     * @returns {boolean} Whether message is guild system message
     */
    isGuildSystemMessage(message) {
        return this.testDetectionPatterns(message, 'guildSystem');
    }

    /**
     * Get specific guild event type
     * @param {string} message - Message text
     * @returns {string} Event type
     */
    getGuildEventType(message) {
        // Get event patterns to determine specific type
        const eventTypes = this.patternLoader.getEventTypes(this.serverName);
        
        for (const eventType of eventTypes) {
            const patterns = this.patternLoader.getPatterns(this.serverName, 'events', eventType);
            
            for (const patternObj of patterns) {
                if (patternObj && patternObj.pattern && patternObj.pattern.test(message)) {
                    return eventType;
                }
            }
        }
        
        // Fallback to legacy detection method
        return this.getLegacyEventType(message);
    }

    /**
     * Get specific guild system type
     * @param {string} message - Message text
     * @returns {string} System type
     */
    getGuildSystemType(message) {
        // Get system patterns to determine specific type
        const systemPatterns = this.patternLoader.getPatterns(this.serverName, 'system');
        
        for (const patternObj of systemPatterns) {
            if (patternObj && patternObj.pattern && patternObj.pattern.test(message)) {
                return patternObj.type || 'unknown';
            }
        }
        
        // Fallback to legacy detection method
        return this.getLegacySystemType(message);
    }

    /**
     * Legacy event type detection (fallback)
     * @param {string} message - Message text
     * @returns {string} Event type
     */
    getLegacyEventType(message) {
        // Join events (including "Guild > username joined.")
        if (/joined\.?$/.test(message) || /joined the guild/.test(message)) return 'join';
        
        // Leave events (including "Guild > username left.")
        if (/left\.?$/.test(message) || /left the guild/.test(message)) return 'leave';
        
        // Kick events
        if (/was kicked|was removed/.test(message)) return 'kick';
        
        // Promotion events (including rank prefixes like [MVP+])
        if (/was promoted/.test(message)) return 'promote';
        
        // Demotion events (including rank prefixes like [MVP+])
        if (/was demoted/.test(message)) return 'demote';
        
        // Invite events
        if (/invited .+ to/.test(message)) return 'invite';
        
        // Guild level events
        if (/Guild.*Level/.test(message)) return 'level';
        
        // MOTD events
        if (/MOTD/.test(message)) return 'motd';
        
        // Guild tag events
        if (/guild tag/.test(message)) return 'misc';
        
        // Guild name events
        if (/renamed the guild/.test(message)) return 'misc';
        
        return 'unknown';
    }

    /**
     * Legacy system type detection (fallback)
     * @param {string} message - Message text
     * @returns {string} System type
     */
    getLegacySystemType(message) {
        if (/Online Members/.test(message)) return 'guild_online';
        if (/Guild Name/.test(message)) return 'guild_info';
        if (/Guild Level/.test(message)) return 'guild_info';
        if (/Guild Tag/.test(message)) return 'guild_info';
        if (/Guild MOTD/.test(message)) return 'guild_info';
        if (/cannot use|permission/.test(message)) return 'command_error';
        
        return 'unknown';
    }

    /**
     * Legacy method for backward compatibility
     * @param {string} message - Message text
     * @returns {boolean} Whether message is guild related
     */
    isGuildMessage(message) {
        return this.isGuildChatMessage(message) || 
               this.isOfficerChatMessage(message) || 
               this.isGuildEventMessage(message) || 
               this.isGuildSystemMessage(message);
    }

    /**
     * Legacy method for backward compatibility
     * @param {string} message - Message text
     * @returns {boolean} Whether message is system message
     */
    isSystemMessage(message) {
        return this.isGuildEventMessage(message) || this.isGuildSystemMessage(message);
    }

    /**
     * Get strategy statistics
     * @returns {object} Strategy statistics
     */
    getStatistics() {
        const stats = {
            name: this.name,
            serverName: this.serverName,
            detectionPatterns: {},
            cacheSize: this.detectionCache.size
        };

        const detectionTypes = ['guildChat', 'officerChat', 'guildEvent', 'guildSystem'];
        
        detectionTypes.forEach(type => {
            const patterns = this.getDetectionPatterns(type);
            stats.detectionPatterns[type] = {
                count: patterns.length,
                descriptions: patterns.map(p => p.description).filter(d => d)
            };
        });

        return stats;
    }

    /**
     * Clear detection pattern cache
     */
    clearCache() {
        this.detectionCache.clear();
        logger.debug(`${this.name} detection pattern cache cleared`);
    }

    /**
     * Test message against all detection patterns (for debugging)
     * @param {string} messageText - Message to test
     * @returns {object} Test results
     */
    testMessage(messageText) {
        const results = {
            message: messageText,
            strategy: this.name,
            serverName: this.serverName,
            detectionResults: {},
            guildRelated: false,
            processedResult: null
        };

        const detectionTypes = ['guildChat', 'officerChat', 'guildEvent', 'guildSystem'];
        
        detectionTypes.forEach(type => {
            const matches = this.testDetectionPatterns(messageText, type);
            results.detectionResults[type] = matches;
            
            if (matches) {
                results.guildRelated = true;
            }
        });

        if (results.guildRelated) {
            results.processedResult = this.processGuildMessage(messageText, { name: 'Test' });
        }

        return results;
    }

    wait(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
}

module.exports = HypixelStrategy;