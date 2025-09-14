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
        // Try to parse as guild event first (events are more specific)
        const eventData = this.eventParser.parseEvent(rawMessage, guildConfig);
        if (eventData) {
            return {
                category: 'event',
                data: eventData
            };
        }
        
        // Try to parse as chat message
        const chatData = this.chatParser.parseMessage(rawMessage, guildConfig);
        if (chatData.type === 'guild_chat') {
            return {
                category: 'message',
                data: chatData
            };
        }
        
        return {
            category: chatData.type,
            data: chatData
        };
    }

    // Check if message is relevant for bridging
    isRelevantForBridge(rawMessage, guildConfig) {
        const result = this.processMessage(rawMessage, guildConfig);
        return result.category === 'message' || result.category === 'event';
    }
}

module.exports = MessageCoordinator;