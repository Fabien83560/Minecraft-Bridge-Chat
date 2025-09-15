// Specific Imports
const logger = require("../../shared/logger");
const BridgeLocator = require("../../bridgeLocator.js");
const MessagePatterns = require("./patterns/MessagePatterns.js");
const MessageCleaner = require("./utils/MessageCleaner.js");

class ChatParser {
    constructor() {
        const mainBridge = BridgeLocator.getInstance();
        this.config = mainBridge.config;

        this.chatParserConfig = this.config.get("features.chatParser");

        this._patterns = new MessagePatterns(this.chatParserConfig);
        this._cleaner = new MessageCleaner(this.config.get("advanced.messageCleaner"));
    }

    /**
     * Parse a raw Minecraft message
     * @param {string|object} rawMessage - Raw message from Minecraft client
     * @param {object} guildConfig - Guild configuration
     * @returns {object} Parsed message object
     */
    parseMessage(rawMessage, guildConfig) {
        const startTime = Date.now();
        
        try {            
            // Clean and normalize the message
            const messageText = this._cleaner.cleanMessage(rawMessage);
            
            if (this.config.enableDebugLogging) {
                logger.debug(`[${guildConfig.name}] Parsing: "${messageText}"`);
            }
            
            // Check if message should be ignored
            if (this.shouldIgnoreMessage(messageText)) {
                return this.createIgnoredMessageResult(messageText, 'filtered_content');
            }
            
            // Try to parse as guild chat message
            const guildChatResult = this.parseGuildChatMessage(messageText, guildConfig);
            if (guildChatResult) {
                return guildChatResult;
            }
            
            // Try to parse as other message types
            const otherMessageResult = this.parseOtherMessageTypes(messageText, guildConfig);
            if (otherMessageResult) {
                return otherMessageResult;
            }
            
            // Unknown message type
            return this.createUnknownMessageResult(messageText, guildConfig);
            
        } catch (error) {
            logger.logError(error, `Error parsing message from ${guildConfig.name}`);
            return this.createErrorMessageResult(rawMessage, error, guildConfig);
        }
    }

    /**
     * Parse guild chat message (guild and officer chat)
     * @param {string} messageText - Cleaned message text
     * @param {object} guildConfig - Guild configuration
     * @returns {object|null} Parsed guild message or null
     */
    parseGuildChatMessage(messageText, guildConfig) {
        // Try guild message patterns
        const guildMatch = this._patterns.matchGuildMessage(messageText);
        if (guildMatch) {
            return this.createGuildMessageResult(guildMatch, messageText, guildConfig);
        }
        
        // Try officer message patterns
        const officerMatch = this._patterns.matchOfficerMessage(messageText);
        if (officerMatch) {
            return this.createOfficerMessageResult(officerMatch, messageText, guildConfig);
        }
        
        return null;
    }

    /**
     * Parse other message types (private, party, system, etc.)
     * @param {string} messageText - Cleaned message text
     * @param {object} guildConfig - Guild configuration
     * @returns {object|null} Parsed message or null
     */
    parseOtherMessageTypes(messageText, guildConfig) {
        // Try private message patterns
        const privateMatch = this._patterns.matchPrivateMessage(messageText);
        if (privateMatch) {
            return this.createPrivateMessageResult(privateMatch, messageText, guildConfig);
        }
        
        // Try party message patterns
        const partyMatch = this._patterns.matchPartyMessage(messageText);
        if (partyMatch) {
            return this.createPartyMessageResult(partyMatch, messageText, guildConfig);
        }
        
        // Try system message patterns
        const systemMatch = this._patterns.matchSystemMessage(messageText);
        if (systemMatch) {
            return this.createSystemMessageResult(systemMatch, messageText, guildConfig);
        }
        
        return null;
    }

    /**
     * Check if message should be ignored
     * @param {string} messageText - Message text
     * @returns {boolean} Whether to ignore the message
     */
    shouldIgnoreMessage(messageText) {
        return this._patterns.shouldIgnore(messageText);
    }

    // ==================== RESULT CREATION METHODS ====================

    /**
     * Create guild message result
     * @param {object} match - Pattern match result
     * @param {string} rawText - Original message text
     * @param {object} guildConfig - Guild configuration
     * @returns {object} Guild message result
     */
    createGuildMessageResult(match, rawText, guildConfig) {
        const baseResult = this.createBaseMessageResult('guild_chat', rawText, guildConfig);
        
        return {
            ...baseResult,
            chatType: 'guild',
            username: match.username,
            message: this._cleaner.cleanMessageContent(match.message),
            rank: match.rank || null,
            messageCategory: 'chat',
            parsed: {
                username: match.username,
                message: match.message,
                rank: match.rank,
                rawMatch: match
            }
        };
    }

    /**
     * Create officer message result
     * @param {object} match - Pattern match result
     * @param {string} rawText - Original message text
     * @param {object} guildConfig - Guild configuration
     * @returns {object} Officer message result
     */
    createOfficerMessageResult(match, rawText, guildConfig) {
        const baseResult = this.createBaseMessageResult('guild_chat', rawText, guildConfig);
        
        return {
            ...baseResult,
            chatType: 'officer',
            username: match.username,
            message: this._cleaner.cleanMessageContent(match.message),
            rank: match.rank || null,
            messageCategory: 'chat',
            isOfficerChat: true,
            parsed: {
                username: match.username,
                message: match.message,
                rank: match.rank,
                rawMatch: match
            }
        };
    }

    /**
     * Create private message result
     * @param {object} match - Pattern match result
     * @param {string} rawText - Original message text
     * @param {object} guildConfig - Guild configuration
     * @returns {object} Private message result
     */
    createPrivateMessageResult(match, rawText, guildConfig) {
        const baseResult = this.createBaseMessageResult('private_message', rawText, guildConfig);
        
        return {
            ...baseResult,
            chatType: 'private',
            username: match.username,
            message: this._cleaner.cleanMessageContent(match.message),
            direction: match.direction, // 'from' or 'to'
            messageCategory: 'private',
            parsed: {
                username: match.username,
                message: match.message,
                direction: match.direction,
                rawMatch: match
            }
        };
    }

    /**
     * Create party message result
     * @param {object} match - Pattern match result
     * @param {string} rawText - Original message text
     * @param {object} guildConfig - Guild configuration
     * @returns {object} Party message result
     */
    createPartyMessageResult(match, rawText, guildConfig) {
        const baseResult = this.createBaseMessageResult('party_message', rawText, guildConfig);
        
        return {
            ...baseResult,
            chatType: 'party',
            username: match.username,
            message: this._cleaner.cleanMessageContent(match.message),
            messageCategory: 'party',
            parsed: {
                username: match.username,
                message: match.message,
                rawMatch: match
            }
        };
    }

    /**
     * Create system message result
     * @param {object} match - Pattern match result
     * @param {string} rawText - Original message text
     * @param {object} guildConfig - Guild configuration
     * @returns {object} System message result
     */
    createSystemMessageResult(match, rawText, guildConfig) {
        const baseResult = this.createBaseMessageResult('system_message', rawText, guildConfig);
        
        return {
            ...baseResult,
            chatType: 'system',
            messageCategory: 'system',
            systemType: match.systemType,
            parsed: {
                systemType: match.systemType,
                data: match.data,
                rawMatch: match
            }
        };
    }

    /**
     * Create ignored message result
     * @param {string} rawText - Original message text
     * @param {string} reason - Reason for ignoring
     * @returns {object} Ignored message result
     */
    createIgnoredMessageResult(rawText, reason) {        
        return {
            type: 'ignored',
            raw: rawText,
            reason: reason,
            timestamp: Date.now(),
            parsedSuccessfully: false
        };
    }

    /**
     * Create unknown message result
     * @param {string} rawText - Original message text
     * @param {object} guildConfig - Guild configuration
     * @returns {object} Unknown message result
     */
    createUnknownMessageResult(rawText, guildConfig) {        
        const baseResult = this.createBaseMessageResult('unknown', rawText, guildConfig);
        
        if (this.config.enableDebugLogging) {
            logger.debug(`[${guildConfig.name}] UNKNOWN: ${rawText.substring(0, 100)}`);
        }
        
        return {
            ...baseResult,
            reason: 'no_pattern_match',
            parsedSuccessfully: false
        };
    }

    /**
     * Create error message result
     * @param {string} rawMessage - Original raw message
     * @param {Error} error - Error that occurred
     * @param {object} guildConfig - Guild configuration
     * @returns {object} Error message result
     */
    createErrorMessageResult(rawMessage, error, guildConfig) {
        return {
            type: 'error',
            raw: typeof rawMessage === 'string' ? rawMessage : String(rawMessage),
            error: {
                message: error.message,
                stack: error.stack
            },
            guildId: guildConfig.id,
            guildName: guildConfig.name,
            timestamp: Date.now(),
            parsedSuccessfully: false
        };
    }

    /**
     * Create base message result with common properties
     * @param {string} type - Message type
     * @param {string} rawText - Original message text
     * @param {object} guildConfig - Guild configuration
     * @returns {object} Base message result
     */
    createBaseMessageResult(type, rawText, guildConfig) {
        return {
            type: type,
            raw: rawText,
            guildId: guildConfig.id,
            guildName: guildConfig.name,
            guildTag: guildConfig.tag,
            timestamp: Date.now(),
            parsedSuccessfully: true,
            parser: 'ChatParser',
            parserVersion: '2.0.0'
        };
    }

    // ==================== UTILITY METHODS ====================

    /**
     * Check if a message is a guild chat message (for external use)
     * @param {string|object} rawMessage - Raw message
     * @param {object} guildConfig - Guild configuration
     * @returns {boolean} Whether message is guild chat
     */
    isGuildMessage(rawMessage, guildConfig) {
        try {
            const parsed = this.parseMessage(rawMessage, guildConfig);
            return parsed.type === 'guild_chat';
        } catch (error) {
            logger.logError(error, 'Error checking if message is guild message');
            return false;
        }
    }

    /**
     * Get current configuration
     * @returns {object} Current configuration
     */
    getChatParserConfig() {
        return this.config;
    }

    /**
     * Get pattern matcher for external access
     * @returns {MessagePatterns} Pattern matcher instance
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
}

module.exports = ChatParser;