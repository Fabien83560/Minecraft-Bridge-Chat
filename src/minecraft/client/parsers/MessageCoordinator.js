/**
 * Message Coordinator - Central Message Processing and Routing
 * 
 * This file coordinates the parsing and processing of Minecraft messages that have
 * been pre-filtered by server strategies. It serves as the central routing point
 * between raw Minecraft messages and their parsed, structured representations.
 * 
 * Key responsibilities:
 * - Message parsing coordination between ChatParser and EventParser
 * - Multi-layered infinite loop prevention (defense in depth)
 * - Inter-guild relay pattern detection and filtering
 * - Message categorization (message, event, ignored, unknown)
 * - Chat type detection (guild chat, officer chat)
 * - Message relevance determination for bridging
 * - Specialized processing methods for different message types
 * 
 * The coordinator implements a layered filtering approach:
 * 1. Strategy-level filtering (HypixelStrategy.isOwnBotMessage)
 * 2. Coordinator-level filtering (isOwnBotMessage)
 * 3. Inter-guild relay pattern detection (isInterGuildRelayMessage)
 * 
 * This multi-layered approach ensures maximum protection against infinite loops
 * when bots relay messages between guilds.
 * 
 * Processing flow:
 * 1. Receive pre-filtered guild message from strategy
 * 2. Attempt event parsing (events are more specific)
 * 3. If not event, attempt chat parsing
 * 4. Apply additional filtering (own bot, relay patterns)
 * 5. Return categorized result with parsed data
 * 
 * Message categories:
 * - 'message': Guild chat messages (including officer chat)
 * - 'event': Guild events (joins, leaves, promotions, etc.)
 * - 'ignored': Filtered messages (own bot, relay patterns)
 * - 'unknown': Unparseable messages
 * 
 * @author Fabien83560
 * @version 1.0.0
 * @license ISC
 */

// Specific Imports
const BridgeLocator = require("../../../bridgeLocator.js");
const ChatParser = require("./ChatParser.js");
const EventParser = require("./EventParser.js");
const logger = require("../../../shared/logger");
const metrics = require("../../../shared/BridgeMetrics.js");

/**
 * MessageCoordinator - Coordinates message parsing and filtering
 * 
 * Central coordinator for processing guild messages, routing between parsers,
 * and applying multiple layers of filtering to prevent infinite loops.
 * 
 * @class
 */
class MessageCoordinator {
    /**
     * Initialize the message coordinator
     * 
     * Sets up:
     * - Configuration from main bridge
     * - ChatParser instance for message parsing
     * - EventParser instance for event parsing
     * 
     * @example
     * const coordinator = new MessageCoordinator();
     * const result = coordinator.processMessage(message, guildConfig);
     */
    constructor() {
        const mainBridge = BridgeLocator.getInstance();
        this.config = mainBridge.config;

        this.chatParser = new ChatParser();
        this.eventParser = new EventParser();
    }

    /**
     * Process a guild message (pre-filtered by strategy)
     * 
     * Main entry point for message processing. Routes message through appropriate
     * parser and applies additional filtering layers.
     * 
     * Processing priority:
     * 1. Event parsing (more specific patterns)
     * 2. Chat parsing (guild and officer chat)
     * 3. Additional filtering (own bot, relay patterns)
     * 4. Categorization and return
     * 
     * Return object structure:
     * {
     *   category: 'message' | 'event' | 'ignored' | 'unknown',
     *   data: {
     *     type: string,          // Specific message type
     *     username: string,      // Username if applicable
     *     message: string,       // Message content if applicable
     *     chatType: string,      // 'guild' or 'officer' for messages
     *     ...                    // Additional type-specific data
     *   }
     * }
     * 
     * @param {string|object} rawMessage - Raw message from Minecraft client
     * @param {object} guildConfig - Guild configuration
     * @param {string} guildConfig.name - Guild name
     * @param {object} guildConfig.account - Account configuration
     * @param {string} guildConfig.account.username - Bot username
     * @returns {object} Processing result with category and parsed data
     * 
     * @example
     * const result = coordinator.processMessage(
     *   "Guild > [MVP+] Player: Hello!",
     *   guildConfig
     * );
     * // Returns: { category: 'message', data: { type: 'guild_chat', ... } }
     * 
     * @example
     * const result = coordinator.processMessage(
     *   "Guild > Player joined.",
     *   guildConfig
     * );
     * // Returns: { category: 'event', data: { type: 'join', ... } }
     */
    stripHypixelWarning(rawMessage) {
        const messageText = typeof rawMessage === 'string' ? rawMessage : rawMessage.toString();
        const hypixelWarning = 'Please be mindful of Discord links in chat as they may pose a security risk';
        if (messageText.includes(hypixelWarning)) {
            return messageText.replace(hypixelWarning, '').trim();
        }
        return messageText;
    }

    processMessage(rawMessage, guildConfig) {
        let messageText = this.stripHypixelWarning(rawMessage);

        if (messageText !== (typeof rawMessage === 'string' ? rawMessage : rawMessage.toString())) {
            logger.debug(`[GUILD] [${guildConfig.name}] Stripping Hypixel Discord link warning from message`);
            rawMessage = messageText;
        }

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
        
        // Try to parse as chat message (including officer chat)
        const chatData = this.chatParser.parseMessage(rawMessage, guildConfig);
        if (chatData.type === 'guild_chat') {
            // CHECK: Verify this isn't our own bot message (defense in depth)
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

            // Determine chat type label for logging
            const chatTypeLabel = chatData.chatType === 'officer' ? '[OFFICER]' : '[GUILD]';
            logger.bridge(`${chatTypeLabel} [${guildConfig.name}] Parsed as ${chatData.chatType} chat - Username: ${chatData.username}, Message: "${chatData.message}"`);
            
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
     * Check if parsed chat data represents our own bot message
     * 
     * CRITICAL: Second layer of defense against infinite loops.
     * Performs case-insensitive username comparison between message sender
     * and bot username from configuration.
     * 
     * This check happens AFTER strategy-level filtering, providing
     * additional protection if strategy filtering fails.
     * 
     * @param {object} chatData - Parsed chat data from ChatParser
     * @param {string} chatData.username - Message sender username
     * @param {string} [chatData.message] - Message content
     * @param {string} [chatData.chatType] - Chat type (guild or officer)
     * @param {object} guildConfig - Guild configuration
     * @param {object} guildConfig.account - Account configuration
     * @param {string} guildConfig.account.username - Bot username
     * @returns {boolean} Whether this is our own bot message
     * 
     * @example
     * const chatData = { username: 'MyBot', message: 'Hello' };
     * const isOwn = coordinator.isOwnBotMessage(chatData, {
     *   account: { username: 'MyBot' }
     * });
     * // Returns: true
     */
    isOwnBotMessage(chatData, guildConfig) {
        if (!chatData.username || !guildConfig.account.username) {
            return false;
        }
        
        const botUsername = guildConfig.account.username.toLowerCase();
        const messageUsername = chatData.username.toLowerCase();
        
        const isOwnBot = messageUsername === botUsername;
        
        if (isOwnBot) {
            const chatType = chatData.chatType || 'guild';
            logger.debug(`[${guildConfig.name}] ✅ FILTERED own bot ${chatType} message: ${chatData.username} -> "${chatData.message?.substring(0, 50)}${chatData.message?.length > 50 ? '...' : ''}"`);
        }
        
        return isOwnBot;
    }

    /**
     * Check if message appears to be an inter-guild relay
     * 
     * CRITICAL: Third layer of defense against infinite loops.
     * Detects various patterns that indicate a message is being relayed
     * between guilds, which could cause infinite relay loops.
     * 
     * Detection patterns:
     * 1. Bot relaying format: "OtherUser: actual message"
     * 2. Username chains: "User1: User1: message"
     * 3. Multi-user relay: "User1: User2: User3: message"
     * 4. Guild tag patterns: "[TAG] User: message"
     * 5. Bot echo: Bot mentioning itself in message
     * 6. Officer-specific relay patterns
     * 
     * Supports both guild and officer chat detection through chatType parameter.
     * 
     * @param {object} chatData - Parsed chat data from ChatParser
     * @param {string} chatData.message - Message content to analyze
     * @param {string} chatData.username - Message sender username
     * @param {string} [chatData.chatType] - Chat type ('guild' or 'officer')
     * @param {object} guildConfig - Guild configuration
     * @param {object} guildConfig.account - Account configuration
     * @param {string} guildConfig.account.username - Bot username
     * @param {string} guildConfig.name - Guild name for logging
     * @returns {boolean} Whether message appears to be an inter-guild relay
     * 
     * @example
     * const chatData = {
     *   username: 'MyBot',
     *   message: 'OtherUser: Hello from another guild',
     *   chatType: 'guild'
     * };
     * const isRelay = coordinator.isInterGuildRelayMessage(chatData, guildConfig);
     * // Returns: true (detected Pattern 1)
     * 
     * @example
     * const chatData = {
     *   username: 'Player',
     *   message: 'Hello everyone!',
     *   chatType: 'guild'
     * };
     * const isRelay = coordinator.isInterGuildRelayMessage(chatData, guildConfig);
     * // Returns: false (no relay pattern detected)
     */
    isInterGuildRelayMessage(chatData, guildConfig) {
        if (!chatData.message || !chatData.username) {
            return false;
        }

        const message = chatData.message;
        const username = chatData.username;
        const chatType = chatData.chatType || 'guild';

        // This method is only ever reached after isOwnBotMessage() has already returned
        // false, so by construction the sender is never our own bot. The previous
        // implementation nevertheless tested six content-shape patterns against the
        // message body - "[TAG] User: msg", "User: User: msg", and for officer chat
        // anything matching /.*?(?:officer|admin).*?:/ - none of which could ever fire
        // on a bot message. They only ever fired on real players, silently dropping
        // legitimate chat such as "admin: c'est bon" or "[test] moi: salut".
        //
        // The reliable signal is the sender being one of the bridge's own bot accounts
        // (a different guild's bot relaying into this one), or the body carrying a
        // source tag that only this bridge emits.
        const relayInfo = this.detectBridgeRelay(username, message, guildConfig);

        if (relayInfo) {
            logger.debug(`[${guildConfig.name}] ✅ FILTERED ${chatType} relay (${relayInfo}): "${message.substring(0, 50)}..."`);
            metrics.filtered('mc_to_discord', `relay_${relayInfo}`);
            return true;
        }

        return false;
    }

    /**
     * Detect content relayed by one of the bridge's own bot accounts
     *
     * Returns a short reason slug when the message is bridge-produced, or null when it
     * is genuine player chat. Two signals are used:
     *
     * 1. The sender matches a configured bot account for any enabled guild. Real members
     *    never carry those names, so this is unambiguous.
     * 2. The body starts with a configured guild tag in the "[V1] " form this bridge
     *    emits when showSourceTag is on. Only the bridge produces that prefix.
     *
     * @param {string} username - Message sender
     * @param {string} message - Message body
     * @param {object} guildConfig - Guild configuration (used for logging context)
     * @returns {string|null} Reason slug ('bridge_bot' or 'source_tag'), or null
     *
     * @example
     * coordinator.detectBridgeRelay('FrenchLegacyV2', 'Player: salut', guildConfig);
     * // Returns: 'bridge_bot'
     *
     * @example
     * coordinator.detectBridgeRelay('Pierre8063', 'admin: c\'est bon', guildConfig);
     * // Returns: null - genuine chat that used to be dropped
     */
    detectBridgeRelay(username, message, guildConfig) {
        try {
            const allGuilds = this.config.getEnabledGuilds() || [];

            const isBridgeBot = allGuilds.some(guild =>
                guild.account?.username &&
                guild.account.username.toLowerCase() === username.toLowerCase()
            );

            if (isBridgeBot) {
                return 'bridge_bot';
            }

            const tags = allGuilds
                .map(guild => guild.tag)
                .filter(Boolean)
                .map(tag => tag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));

            if (tags.length > 0) {
                const tagPattern = new RegExp(`^\\[(?:${tags.join('|')})\\]\\s`, 'i');
                if (tagPattern.test(message)) {
                    return 'source_tag';
                }
            }

            return null;

        } catch (error) {
            logger.logError(error, `Error detecting bridge relay for ${guildConfig.name}`);
            return null;
        }
    }

    /**
     * Check if message is relevant for bridging
     * 
     * Determines if a processed message should be forwarded to bridge systems
     * (Discord, web, etc.). Messages are relevant if they are categorized as
     * 'message' (guild/officer chat) or 'event' (guild events).
     * 
     * Note: Messages reaching this method have already been filtered by strategy,
     * so they should always be guild-related.
     * 
     * @param {string|object} rawMessage - Raw message from Minecraft
     * @param {object} guildConfig - Guild configuration
     * @returns {boolean} Whether message is relevant for bridging
     * 
     * @example
     * const isRelevant = coordinator.isRelevantForBridge(message, guildConfig);
     * if (isRelevant) {
     *   sendToDiscord(message);
     * }
     */
    isRelevantForBridge(rawMessage, guildConfig) {
        const result = this.processMessage(rawMessage, guildConfig);
        const isRelevant = result.category === 'message' || result.category === 'event';
        
        if (isRelevant) {
            const chatTypeLabel = result.data.chatType === 'officer' ? '[OFFICER]' : '[GUILD]';
            logger.bridge(`${chatTypeLabel} [${guildConfig.name}] Message is relevant for bridging - Category: ${result.category}`);
        } else {
            logger.bridge(`[GUILD] [${guildConfig.name}] Message not relevant for bridging - Category: ${result.category}`);
        }
        
        return isRelevant;
    }

    /**
     * Process guild chat message specifically (including officer chat)
     * 
     * Specialized method for processing only guild/officer chat messages.
     * Returns null if message is not guild chat or is filtered.
     * 
     * Applies same filtering as processMessage:
     * - Own bot message filtering
     * - Inter-guild relay pattern detection
     * 
     * @param {string|object} rawMessage - Raw message from Minecraft
     * @param {object} guildConfig - Guild configuration
     * @returns {object|null} Parsed chat message or null if not guild chat
     * 
     * @example
     * const chatData = coordinator.processGuildChatMessage(message, guildConfig);
     * if (chatData) {
     *   console.log(`${chatData.username}: ${chatData.message}`);
     * }
     */
    processGuildChatMessage(rawMessage, guildConfig) {
        logger.bridge(`[GUILD] [${guildConfig.name}] Processing specifically as guild chat message`);

        rawMessage = this.stripHypixelWarning(rawMessage);
        const chatData = this.chatParser.parseMessage(rawMessage, guildConfig);
        
        if (chatData.type === 'guild_chat') {
            // Apply the same filtering as in processMessage
            if (this.isOwnBotMessage(chatData, guildConfig) || this.isInterGuildRelayMessage(chatData, guildConfig)) {
                logger.debug(`[GUILD] [${guildConfig.name}] Filtered ${chatData.chatType || 'guild'} chat message from ${chatData.username}`);
                return null;
            }
            
            const chatTypeLabel = chatData.chatType === 'officer' ? '[OFFICER]' : '[GUILD]';
            logger.bridge(`${chatTypeLabel} [${guildConfig.name}] Successfully parsed ${chatData.chatType} chat - ${chatData.username}: "${chatData.message}"`);
            return chatData;
        }
        
        return null;
    }

    /**
     * Process officer chat message specifically
     * 
     * Specialized method for processing only officer chat messages.
     * Returns null if message is not officer chat or is filtered.
     * 
     * Applies same filtering as processMessage:
     * - Own bot message filtering
     * - Inter-guild relay pattern detection (officer-specific patterns)
     * 
     * @param {string|object} rawMessage - Raw message from Minecraft
     * @param {object} guildConfig - Guild configuration
     * @returns {object|null} Parsed officer message or null if not officer chat
     * 
     * @example
     * const officerData = coordinator.processOfficerChatMessage(message, guildConfig);
     * if (officerData) {
     *   console.log(`[OFFICER] ${officerData.username}: ${officerData.message}`);
     * }
     */
    processOfficerChatMessage(rawMessage, guildConfig) {
        logger.bridge(`[OFFICER] [${guildConfig.name}] Processing specifically as officer chat message`);

        rawMessage = this.stripHypixelWarning(rawMessage);
        const chatData = this.chatParser.parseMessage(rawMessage, guildConfig);
        
        if (chatData.type === 'guild_chat' && chatData.chatType === 'officer') {
            // Apply the same filtering as in processMessage
            if (this.isOwnBotMessage(chatData, guildConfig) || this.isInterGuildRelayMessage(chatData, guildConfig)) {
                logger.debug(`[OFFICER] [${guildConfig.name}] Filtered officer chat message from ${chatData.username}`);
                return null;
            }
            
            logger.bridge(`[OFFICER] [${guildConfig.name}] Successfully parsed officer chat - ${chatData.username}: "${chatData.message}"`);
            return chatData;
        }
        
        return null;
    }

    /**
     * Process guild event specifically
     * 
     * Specialized method for processing only guild events.
     * Returns null if message is not a successfully parsed event.
     * 
     * Events include:
     * - Member joins and leaves
     * - Promotions and demotions
     * - Kicks and invites
     * - Guild level changes
     * - MOTD updates
     * 
     * @param {string|object} rawMessage - Raw message from Minecraft
     * @param {object} guildConfig - Guild configuration
     * @returns {object|null} Parsed event or null if not an event
     * 
     * @example
     * const eventData = coordinator.processGuildEvent(message, guildConfig);
     * if (eventData) {
     *   console.log(`Event: ${eventData.type} - ${eventData.username}`);
     * }
     */
    processGuildEvent(rawMessage, guildConfig) {
        logger.bridge(`[GUILD] [${guildConfig.name}] Processing specifically as guild event`);

        rawMessage = this.stripHypixelWarning(rawMessage);
        const eventData = this.eventParser.parseEvent(rawMessage, guildConfig);
        
        if (eventData && eventData.parsedSuccessfully) {
            logger.bridge(`[GUILD] [${guildConfig.name}] Successfully parsed guild event - ${eventData.type}: ${eventData.username || 'system'}`);
            return eventData;
        }
        
        return null;
    }

    /**
     * Check if message is specifically officer chat
     * 
     * Quick check method for officer chat detection without full processing.
     * 
     * @param {string|object} rawMessage - Raw message from Minecraft
     * @param {object} guildConfig - Guild configuration
     * @returns {boolean} Whether message is officer chat
     * 
     * @example
     * if (coordinator.isOfficerChatMessage(message, guildConfig)) {
     *   console.log('Officer chat detected');
     * }
     */
    isOfficerChatMessage(rawMessage, guildConfig) {
        rawMessage = this.stripHypixelWarning(rawMessage);
        const chatData = this.chatParser.parseMessage(rawMessage, guildConfig);
        return chatData.type === 'guild_chat' && chatData.chatType === 'officer';
    }

    /**
     * Check if message is guild chat (including officer chat)
     * 
     * Quick check method for guild chat detection without full processing.
     * Returns true for both regular guild chat and officer chat.
     * 
     * @param {string|object} rawMessage - Raw message from Minecraft
     * @param {object} guildConfig - Guild configuration
     * @returns {boolean} Whether message is guild chat (including officer)
     * 
     * @example
     * if (coordinator.isGuildChatMessage(message, guildConfig)) {
     *   console.log('Guild chat detected');
     * }
     */
    isGuildChatMessage(rawMessage, guildConfig) {
        rawMessage = this.stripHypixelWarning(rawMessage);
        const chatData = this.chatParser.parseMessage(rawMessage, guildConfig);
        return chatData.type === 'guild_chat';
    }
}

module.exports = MessageCoordinator;