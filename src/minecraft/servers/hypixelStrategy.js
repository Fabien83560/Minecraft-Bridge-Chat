// Specific Imports
const logger = require("../../shared/logger");

class HypixelStrategy {
    constructor() {
        this.name = "HypixelStrategy";
        this.limboDelay = 3000;
    }

    async onConnect(bot, guildConfig) {
        logger.minecraft(`🏰 Hypixel connection strategy for ${guildConfig.name}`);
        
        // Wait for connection to stabilize
        await this.wait(this.limboDelay);
        
        // Go to limbo to avoid disconnections
        await this.goToLimbo(bot, guildConfig);
    }

    async onReconnect(bot, guildConfig) {
        logger.minecraft(`🔄 Hypixel reconnection strategy for ${guildConfig.name}`);
        
        // Wait longer after reconnection
        await this.wait(this.limboDelay);
        
        // Always return to limbo after reconnection
        await this.goToLimbo(bot, guildConfig);
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

        // Check if this is a guild-related message
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
     * Process and classify guild messages
     * @param {string} messageText - Raw message text
     * @param {object} guildConfig - Guild configuration
     * @returns {object|null} Guild message data or null
     */
    processGuildMessage(messageText, guildConfig) {
        // Guild Chat Messages
        if (this.isGuildChatMessage(messageText)) {
            return {
                type: 'GUILD_CHAT',
                category: 'chat',
                subtype: 'guild',
                raw: messageText,
                isGuildRelated: true
            };
        }

        // Officer Chat Messages
        if (this.isOfficerChatMessage(messageText)) {
            return {
                type: 'OFFICER_CHAT',
                category: 'chat',
                subtype: 'officer',
                raw: messageText,
                isGuildRelated: true
            };
        }

        // Guild Events (join, leave, kick, promote, etc.)
        if (this.isGuildEventMessage(messageText)) {
            return {
                type: 'GUILD_EVENT',
                category: 'event',
                subtype: this.getGuildEventType(messageText),
                raw: messageText,
                isGuildRelated: true
            };
        }

        // Guild System Messages (online members, guild info, etc.)
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
     * Check if message is guild chat
     * @param {string} message - Message text
     * @returns {boolean} Whether message is guild chat
     */
    isGuildChatMessage(message) {
        const guildChatPatterns = [
            // Standard guild chat patterns
            /^Guild > /,
            /^G > /,
            /^\[Guild\]/,
            
            // With color codes
            /^§2Guild > /,
            /^§aGuild > /,
            /^§2G > /,
            /^§aG > /,
            
            // Alternative formats
            /^Guild Chat > /,
            /^§2Guild Chat > /
        ];
        
        return guildChatPatterns.some(pattern => pattern.test(message));
    }

    /**
     * Check if message is officer chat
     * @param {string} message - Message text
     * @returns {boolean} Whether message is officer chat
     */
    isOfficerChatMessage(message) {
        const officerChatPatterns = [
            // Standard officer chat patterns
            /^Officer > /,
            /^O > /,
            /^\[Officer\]/,
            
            // With color codes
            /^§3Officer > /,
            /^§bOfficer > /,
            /^§3O > /,
            /^§bO > /
        ];
        
        return officerChatPatterns.some(pattern => pattern.test(message));
    }

    /**
     * Check if message is a guild event
     * @param {string} message - Message text
     * @returns {boolean} Whether message is guild event
     */
    isGuildEventMessage(message) {
        const guildEventPatterns = [
            // Member events
            /joined the guild/,
            /left the guild/,
            /was kicked from the guild/,
            /was removed from the guild/,
            
            // Rank events
            /was promoted/,
            /was demoted/,
            /is now .+ in the guild/,
            
            // Invite events
            /invited .+ to the guild/,
            /accepted .+ guild invitation/,
            
            // Guild level events
            /Guild has reached Level/,
            /Guild leveled up/,
            
            // MOTD events
            /changed the guild MOTD/,
            /Guild MOTD updated/,
            
            // Guild settings events
            /changed the guild tag/,
            /renamed the guild/,
            /updated the guild description/
        ];
        
        return guildEventPatterns.some(pattern => pattern.test(message));
    }

    /**
     * Check if message is guild system message
     * @param {string} message - Message text
     * @returns {boolean} Whether message is guild system message
     */
    isGuildSystemMessage(message) {
        const guildSystemPatterns = [
            // Online members
            /^Online Members:/,
            /^Guild Members Online/,
            /guild members online:/,
            
            // Guild info
            /^Guild Name:/,
            /^Guild Level:/,
            /^Guild Tag:/,
            /^Guild MOTD:/,
            
            // Guild commands responses
            /^You cannot use this command/,
            /^Guild .+ executed/,
            /^You do not have permission/
        ];
        
        return guildSystemPatterns.some(pattern => pattern.test(message));
    }

    /**
     * Get specific guild event type
     * @param {string} message - Message text
     * @returns {string} Event type
     */
    getGuildEventType(message) {
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
        if (/Guild.*Level/.test(message)) return 'level_up';
        
        // MOTD events
        if (/MOTD/.test(message)) return 'motd_change';
        
        // Guild tag events
        if (/guild tag/.test(message)) return 'tag_change';
        
        // Guild name events
        if (/renamed the guild/.test(message)) return 'name_change';
        
        return 'unknown';
    }

    /**
     * Get specific guild system type
     * @param {string} message - Message text
     * @returns {string} System type
     */
    getGuildSystemType(message) {
        if (/Online Members/.test(message)) return 'online_list';
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

    wait(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
}

module.exports = HypixelStrategy;