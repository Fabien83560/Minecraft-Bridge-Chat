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

    processMessage(rawMessage, guildConfig) {
        const messageText = typeof rawMessage === 'string' ? rawMessage : rawMessage.toString();
        
        logger.bridge(`[${guildConfig.name}] Coordinator processing message: "${messageText.substring(0, 100)}${messageText.length > 100 ? '...' : ''}"`);
        
        // Try to parse as guild event first (events are more specific)
        const eventData = this.eventParser.parseEvent(rawMessage, guildConfig);
        if (eventData && eventData.parsedSuccessfully) {
            logger.bridge(`[${guildConfig.name}] Parsed as event - Type: ${eventData.type}, Username: ${eventData.username || 'system'}`);
            return {
                category: 'event',
                data: eventData
            };
        }
        
        // Try to parse as chat message
        const chatData = this.chatParser.parseMessage(rawMessage, guildConfig);
        if (chatData.type === 'guild_chat') {
            logger.bridge(`[${guildConfig.name}] Parsed as guild chat - Chat Type: ${chatData.chatType}, Username: ${chatData.username}, Message: "${chatData.message}"`);
            return {
                category: 'message',
                data: chatData
            };
        }
        
        // Log other message types for debugging
        if (chatData.type !== 'ignored' && chatData.type !== 'unknown') {
            logger.bridge(`[${guildConfig.name}] Parsed as ${chatData.type} - Category: ${chatData.messageCategory || 'unknown'}`);
        } else if (chatData.type === 'ignored') {
            logger.debug(`[${guildConfig.name}] Message ignored - Reason: ${chatData.reason}`);
        } else {
            logger.debug(`[${guildConfig.name}] Unknown message type - Raw: "${messageText.substring(0, 50)}${messageText.length > 50 ? '...' : ''}"`);
        }
        
        return {
            category: chatData.type,
            data: chatData
        };
    }

    // Check if message is relevant for bridging
    isRelevantForBridge(rawMessage, guildConfig) {
        const result = this.processMessage(rawMessage, guildConfig);
        const isRelevant = result.category === 'message' || result.category === 'event';
        
        if (isRelevant) {
            logger.bridge(`[${guildConfig.name}] Message is relevant for bridging - Category: ${result.category}`);
        }
        
        return isRelevant;
    }
}

module.exports = MessageCoordinator;