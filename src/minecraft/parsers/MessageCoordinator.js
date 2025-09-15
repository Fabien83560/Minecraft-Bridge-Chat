// Specific Imports
const BridgeLocator = require("../../bridgeLocator.js");
const ChatParser = require("./ChatParser.js");
const EventParser = require("./EventParser.js");
const logger = require("../../shared/logger");

class MessageCoordinator {
    constructor() {
        const mainBridge = BridgeLocator.getInstance();
        this.config = mainBridge.config;

        this.chatParser = new ChatParser();
        this.eventParser = new EventParser();
    }

    /**
     * Process a guild message (pre-filtered by strategy)
     * @param {string|object} rawMessage - Raw message from Minecraft
     * @param {object} guildConfig - Guild configuration
     * @returns {object} Processing result with category and data
     */
    processMessage(rawMessage, guildConfig) {
        const messageText = typeof rawMessage === 'string' ? rawMessage : rawMessage.toString();
        
        // Log with [GUILD] prefix since this message was already filtered by strategy
        logger.bridge(`[GUILD] [${guildConfig.name}] Coordinator processing guild message: "${messageText.substring(0, 100)}${messageText.length > 100 ? '...' : ''}"`);
        
        // Try to parse as guild event first (events are more specific)
        const eventData = this.eventParser.parseEvent(rawMessage, guildConfig);
        if (eventData && eventData.parsedSuccessfully) {
            logger.bridge(`[GUILD] [${guildConfig.name}] Parsed as event - Type: ${eventData.type}, Username: ${eventData.username || 'system'}`);
            return {
                category: 'event',
                data: eventData
            };
        }
        
        // Try to parse as chat message
        const chatData = this.chatParser.parseMessage(rawMessage, guildConfig);
        if (chatData.type === 'guild_chat') {
            logger.bridge(`[GUILD] [${guildConfig.name}] Parsed as guild chat - Chat Type: ${chatData.chatType}, Username: ${chatData.username}, Message: "${chatData.message}"`);
            return {
                category: 'message',
                data: chatData
            };
        }
        
        // Handle other message types that might still be guild-related
        if (chatData.type === 'private_message') {
            logger.bridge(`[GUILD] [${guildConfig.name}] Parsed as private message - Username: ${chatData.username || 'unknown'}`);
        } else if (chatData.type === 'party_message') {
            logger.bridge(`[GUILD] [${guildConfig.name}] Parsed as party message - Username: ${chatData.username || 'unknown'}`);
        } else if (chatData.type === 'system_message') {
            logger.bridge(`[GUILD] [${guildConfig.name}] Parsed as system message - Type: ${chatData.systemType || 'unknown'}`);
        } else if (chatData.type === 'ignored') {
            logger.bridge(`[GUILD] [${guildConfig.name}] Message ignored by parser - Reason: ${chatData.reason}`);
        } else if (chatData.type === 'unknown') {
            logger.bridge(`[GUILD] [${guildConfig.name}] Unknown message type by parser - Raw: "${messageText.substring(0, 50)}${messageText.length > 50 ? '...' : ''}"`);
        } else {
            logger.bridge(`[GUILD] [${guildConfig.name}] Other message type: ${chatData.type} - Category: ${chatData.messageCategory || 'unknown'}`);
        }
        
        return {
            category: chatData.type,
            data: chatData
        };
    }

    /**
     * Check if message is relevant for bridging (should always be true since pre-filtered)
     * @param {string|object} rawMessage - Raw message from Minecraft
     * @param {object} guildConfig - Guild configuration
     * @returns {boolean} Whether message is relevant for bridging
     */
    isRelevantForBridge(rawMessage, guildConfig) {
        const result = this.processMessage(rawMessage, guildConfig);
        const isRelevant = result.category === 'message' || result.category === 'event';
        
        if (isRelevant) {
            logger.bridge(`[GUILD] [${guildConfig.name}] Message is relevant for bridging - Category: ${result.category}`);
        } else {
            logger.bridge(`[GUILD] [${guildConfig.name}] Message not relevant for bridging - Category: ${result.category}`);
        }
        
        return isRelevant;
    }

    /**
     * Process guild chat message specifically
     * @param {string|object} rawMessage - Raw message from Minecraft
     * @param {object} guildConfig - Guild configuration
     * @returns {object|null} Parsed chat message or null
     */
    processGuildChatMessage(rawMessage, guildConfig) {
        logger.bridge(`[GUILD] [${guildConfig.name}] Processing specifically as guild chat message`);
        
        const chatData = this.chatParser.parseMessage(rawMessage, guildConfig);
        
        if (chatData.type === 'guild_chat') {
            logger.bridge(`[GUILD] [${guildConfig.name}] Successfully parsed guild chat - ${chatData.chatType}: ${chatData.username}: "${chatData.message}"`);
            return chatData;
        }
        
        return null;
    }

    /**
     * Process guild event specifically
     * @param {string|object} rawMessage - Raw message from Minecraft
     * @param {object} guildConfig - Guild configuration
     * @returns {object|null} Parsed event or null
     */
    processGuildEvent(rawMessage, guildConfig) {
        logger.bridge(`[GUILD] [${guildConfig.name}] Processing specifically as guild event`);
        
        const eventData = this.eventParser.parseEvent(rawMessage, guildConfig);
        
        if (eventData && eventData.parsedSuccessfully) {
            logger.bridge(`[GUILD] [${guildConfig.name}] Successfully parsed guild event - ${eventData.type}: ${eventData.username || 'system'}`);
            return eventData;
        }
        
        return null;
    }

    /**
     * Get processing statistics for debugging
     * @returns {object} Processing statistics
     */
    getProcessingStats() {
        return {
            coordinator: 'MessageCoordinator',
            version: '2.0.0',
            chatParser: this.chatParser?.constructor?.name || 'ChatParser',
            eventParser: this.eventParser?.constructor?.name || 'EventParser',
            timestamp: new Date().toISOString()
        };
    }

    /**
     * Test message processing for debugging
     * @param {string|object} rawMessage - Raw message to test
     * @param {object} guildConfig - Guild configuration
     * @returns {object} Detailed test results
     */
    testMessageProcessing(rawMessage, guildConfig) {
        const messageText = typeof rawMessage === 'string' ? rawMessage : rawMessage.toString();
        
        logger.bridge(`[GUILD] [${guildConfig.name}] TESTING message processing for: "${messageText}"`);
        
        const testResults = {
            input: {
                raw: rawMessage,
                text: messageText,
                length: messageText.length
            },
            processing: {
                coordinator: this.processMessage(rawMessage, guildConfig),
                chatOnly: this.processGuildChatMessage(rawMessage, guildConfig),
                eventOnly: this.processGuildEvent(rawMessage, guildConfig)
            },
            relevance: {
                isRelevantForBridge: this.isRelevantForBridge(rawMessage, guildConfig)
            },
            metadata: {
                guildName: guildConfig.name,
                guildId: guildConfig.id,
                timestamp: Date.now(),
                processingTime: Date.now() // This would be calculated properly in real implementation
            }
        };
        
        logger.bridge(`[GUILD] [${guildConfig.name}] TEST RESULTS:`, JSON.stringify(testResults, null, 2));
        
        return testResults;
    }
}

module.exports = MessageCoordinator;