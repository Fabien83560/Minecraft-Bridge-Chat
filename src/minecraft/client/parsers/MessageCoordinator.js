// Specific Imports
const BridgeLocator = require("../../../bridgeLocator.js");
const ChatParser = require("./ChatParser.js");
const EventParser = require("./EventParser.js");
const logger = require("../../../shared/logger");

class MessageCoordinator {
    constructor() {
        const mainBridge = BridgeLocator.getInstance();
        this.config = mainBridge.config;

        this.chatParser = new ChatParser();
        this.eventParser = new EventParser();
    }

    /**
     * Process a guild message (pre-filtered by strategy)
     * @param {string|object} rawMessage - Raw message from Minecraft client
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
            // ENHANCED CHECK: Verify this isn't our own bot message (defense in depth)
            if (this.isOwnBotMessage(chatData, guildConfig)) {
                logger.debug(`[GUILD] [${guildConfig.name}] MessageCoordinator filtering own bot message from ${chatData.username}`);
                return {
                    category: 'ignored',
                    data: {
                        type: 'own_bot_message',
                        reason: 'Message sent by our own bot',
                        username: chatData.username,
                        raw: messageText
                    }
                };
            }

            // ADDITIONAL CHECK: Look for inter-guild relay patterns
            if (this.isInterGuildRelayMessage(chatData, guildConfig)) {
                logger.debug(`[GUILD] [${guildConfig.name}] MessageCoordinator filtering potential inter-guild relay from ${chatData.username}`);
                return {
                    category: 'ignored',
                    data: {
                        type: 'inter_guild_relay',
                        reason: 'Message appears to be an inter-guild relay',
                        username: chatData.username,
                        message: chatData.message,
                        raw: messageText
                    }
                };
            }

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
     * ENHANCED: Check if parsed chat data represents our own bot message
     * @param {object} chatData - Parsed chat data
     * @param {object} guildConfig - Guild configuration
     * @returns {boolean} Whether this is our own bot message
     */
    isOwnBotMessage(chatData, guildConfig) {
        if (!chatData.username || !guildConfig.account.username) {
            return false;
        }
        
        const botUsername = guildConfig.account.username.toLowerCase();
        const messageUsername = chatData.username.toLowerCase();
        
        const isOwnBot = messageUsername === botUsername;
        
        if (isOwnBot) {
            logger.debug(`[${guildConfig.name}] Detected own bot message: ${chatData.username} -> "${chatData.message?.substring(0, 50)}${chatData.message?.length > 50 ? '...' : ''}"`);
        }
        
        return isOwnBot;
    }

    /**
     * NEW: Check if message appears to be an inter-guild relay
     * @param {object} chatData - Parsed chat data
     * @param {object} guildConfig - Guild configuration
     * @returns {boolean} Whether this appears to be an inter-guild relay message
     */
    isInterGuildRelayMessage(chatData, guildConfig) {
        if (!chatData.message || !chatData.username) {
            return false;
        }

        const message = chatData.message;
        const username = chatData.username;
        const botUsername = guildConfig.account.username;

        // Pattern 1: Message from bot that looks like "SomeUser: actual message"
        const relayPattern1 = /^(\w+):\s*(.+)$/;
        const relayMatch1 = message.match(relayPattern1);
        
        if (relayMatch1 && username.toLowerCase() === botUsername.toLowerCase()) {
            const relayedUsername = relayMatch1[1];
            const relayedMessage = relayMatch1[2];
            
            logger.debug(`[${guildConfig.name}] Detected relay pattern 1: Bot ${username} relaying message from ${relayedUsername}: "${relayedMessage.substring(0, 30)}..."`);
            return true;
        }

        // Pattern 2: Repeated username chains "User1: User2: User3: message"
        const chainPattern = /^(\w+):\s*\1:\s*(.+)$/;
        const chainMatch = message.match(chainPattern);
        
        if (chainMatch) {
            logger.debug(`[${guildConfig.name}] Detected username chain pattern: "${message.substring(0, 50)}..."`);
            return true;
        }

        // Pattern 3: Multiple colon-separated usernames (sign of relay)
        const multiUserPattern = /^(\w+):\s*(\w+):\s*(\w+):\s*(.+)$/;
        const multiUserMatch = message.match(multiUserPattern);
        
        if (multiUserMatch) {
            logger.debug(`[${guildConfig.name}] Detected multi-user relay pattern: "${message.substring(0, 50)}..."`);
            return true;
        }

        // Pattern 4: Check if bot is relaying based on message structure and timing
        // Messages that contain the bot's own username in the content (potential echo)
        const botEchoPattern = new RegExp(`\\b${botUsername}\\b`, 'i');
        if (username.toLowerCase() === botUsername.toLowerCase() && botEchoPattern.test(message)) {
            logger.debug(`[${guildConfig.name}] Detected potential bot echo: Bot ${username} mentioning itself in message`);
            return true;
        }

        return false;
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
            // Apply the same filtering as in processMessage
            if (this.isOwnBotMessage(chatData, guildConfig) || this.isInterGuildRelayMessage(chatData, guildConfig)) {
                logger.debug(`[GUILD] [${guildConfig.name}] Filtered guild chat message from ${chatData.username}`);
                return null;
            }
            
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
            timestamp: new Date().toISOString(),
            improvements: [
                'Enhanced bot message detection',
                'Inter-guild relay pattern detection',
                'Multiple filtering layers',
                'Improved logging and debugging'
            ]
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
        
        // Parse the message
        const chatData = this.chatParser.parseMessage(rawMessage, guildConfig);
        
        const testResults = {
            input: {
                raw: rawMessage,
                text: messageText,
                length: messageText.length
            },
            parsing: {
                chatData: chatData,
                eventData: this.eventParser.parseEvent(rawMessage, guildConfig)
            },
            filtering: {
                isOwnBot: chatData.username ? this.isOwnBotMessage(chatData, guildConfig) : false,
                isInterGuildRelay: chatData.message ? this.isInterGuildRelayMessage(chatData, guildConfig) : false,
                shouldFilter: false
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
                botUsername: guildConfig.account.username,
                timestamp: Date.now(),
                processingTime: Date.now() // This would be calculated properly in real implementation
            }
        };
        
        // Determine if message should be filtered
        testResults.filtering.shouldFilter = testResults.filtering.isOwnBot || testResults.filtering.isInterGuildRelay;
        
        logger.bridge(`[GUILD] [${guildConfig.name}] TEST RESULTS:`, JSON.stringify(testResults, null, 2));
        
        return testResults;
    }
}

module.exports = MessageCoordinator;