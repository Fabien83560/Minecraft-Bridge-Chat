/**
 * Bridge Coordinator - Bidirectional Message Routing Between Minecraft and Discord
 * 
 * This class coordinates all message and event bridging between Minecraft and Discord,
 * acting as the central hub for bidirectional communication. It handles routing,
 * formatting, delivery tracking, and error management for all types of content
 * flowing between the two platforms.
 * 
 * The coordinator provides:
 * - Bidirectional message bridging (Minecraft ↔ Discord)
 * - Guild event routing and logging with double-logging prevention
 * - Connection status tracking and notifications
 * - Message formatting and transformation between platforms
 * - Delivery tracking with success/failure reporting
 * - Intelligent routing configuration
 * - Error handling with user feedback
 * - Event log system with Discord embeds
 * - UUID fetching and player identification
 * 
 * Routing capabilities:
 * - Minecraft to Discord: Guild chat, officer chat, events, system messages, connections
 * - Discord to Minecraft: Channel messages routed to appropriate guild/officer chat
 * - Event logging: Automatic Discord channel logging based on event type
 * - Command response detection: Prevents duplicate logging when commands are active
 * 
 * Message flow architecture:
 * 1. Minecraft → Discord: Messages/events received → Guild config lookup → Format → Send to Discord
 * 2. Discord → Minecraft: Messages received → Validate → Format → Send to all connected guilds
 * 3. Event logging: Minecraft events → Check active listeners → Send to log channels if no listener
 * 
 * Double-logging prevention:
 * The coordinator intelligently checks for active CommandResponseListener instances to avoid
 * logging events that will be displayed in command responses, preventing duplicate Discord messages.
 * 
 * @author Fabien83560
 * @version 1.0.0
 * @license ISC
 */

// Specific Imports
const BridgeLocator = require("../../bridgeLocator.js");
const logger = require("../../shared/logger");

const CommandResponseListener = require("../client/handlers/CommandResponseListener.js");
const kickReasonStore = require("../../shared/KickReasonStore.js");
const metrics = require("../../shared/BridgeMetrics.js");

/**
 * BridgeCoordinator - Coordinate bidirectional message bridging
 * 
 * Central coordinator class that manages all communication between Minecraft and Discord,
 * including message routing, event handling, and delivery tracking.
 * 
 * @class
 */
class BridgeCoordinator {
    /**
     * Create a new BridgeCoordinator instance
     * 
     * Initializes the coordinator with configuration and sets up routing rules.
     * Manager references are set later via initialize() method to avoid circular dependencies.
     * 
     * Default routing configuration:
     * - guildChatToDiscord: true
     * - officerChatToDiscord: true
     * - eventsToDiscord: true
     * - discordToMinecraft: true
     * - systemMessagesToDiscord: true
     */
    constructor() {
        const mainBridge = BridgeLocator.getInstance();
        this.config = mainBridge.config;

        this.bridgeConfig = this.config.get('bridge');
        
        // References to managers (set via initialize())
        this.discordManager = null;
        this.minecraftManager = null;

        // Message routing configuration
        this.routingConfig = {
            guildChatToDiscord: true,
            officerChatToDiscord: true,
            eventsToDiscord: true,
            discordToMinecraft: true,
            systemMessagesToDiscord: true
        };

        logger.debug('BridgeCoordinator initialized');
    }

    /**
     * Initialize coordinator with manager references
     * 
     * Sets up the coordinator with Discord and Minecraft manager instances and
     * establishes bidirectional event listeners for message routing. This method
     * must be called after both managers are instantiated to complete the bridge setup.
     * 
     * @param {object} discordManager - Discord manager instance
     * @param {object} minecraftManager - Minecraft manager instance
     * 
     * @example
     * const coordinator = new BridgeCoordinator();
     * coordinator.initialize(discordManager, minecraftManager);
     */
    initialize(discordManager, minecraftManager) {
        logger.debug('[BRIDGE] BridgeCoordinator.initialize called');
        
        this.discordManager = discordManager;
        this.minecraftManager = minecraftManager;

        logger.debug(`[BRIDGE] Managers set - Discord: ${!!discordManager}, Minecraft: ${!!minecraftManager}`);
        
        this.setupMinecraftToDiscordBridge();
        this.setupDiscordToMinecraftBridge();

        logger.bridge('BridgeCoordinator initialized with manager references');
    }

    /**
     * Setup Minecraft to Discord message bridging
     * 
     * Establishes event listeners on the Minecraft manager to handle messages,
     * events, and connection status changes. Routes all Minecraft-originated
     * content to appropriate Discord handlers.
     * 
     * Event listeners registered:
     * - onMessage: Guild and officer chat messages
     * - onEvent: Guild events (join, leave, promote, etc.)
     * - onConnection: Connection status changes
     * 
     * @private
     */
    setupMinecraftToDiscordBridge() {
        if (!this.minecraftManager) {
            logger.warn('Minecraft manager not available for bridge setup');
            return;
        }

        if (!this.discordManager) {
            logger.warn('Discord manager not available for bridge setup');
            return;
        }

        logger.debug('[BRIDGE] Setting up Minecraft to Discord event handlers...');

        // Handle Minecraft messages
        // The returned promise is deliberately caught here: these handlers are invoked
        // from EventEmitter callbacks that cannot await them, and main.js treats an
        // unhandled rejection as fatal.
        this.minecraftManager.onMessage((messageData) => {
            this.handleMinecraftMessage(messageData)
                .catch(error => logger.logError(error, 'Unhandled error in handleMinecraftMessage'));
        });

        // Handle Minecraft events
        this.minecraftManager.onEvent((eventData) => {
            this.handleMinecraftEvent(eventData)
                .catch(error => logger.logError(error, 'Unhandled error in handleMinecraftEvent'));
        });

        // Handle Minecraft connection events
        this.minecraftManager.onConnection((connectionData) => {
            logger.debug(`[BRIDGE] Received Minecraft connection event: ${JSON.stringify(connectionData)}`);
            this.handleMinecraftConnection(connectionData)
                .catch(error => logger.logError(error, 'Unhandled error in handleMinecraftConnection'));
        });

        // Send 'connected' status for bots that connected before the bridge was ready
        const alreadyConnected = this.minecraftManager.getConnectedGuilds();
        for (const guild of alreadyConnected) {
            this.handleMinecraftConnection({
                type: 'connected',
                guildId: guild.guildId,
                guildName: guild.guildName,
                username: guild.username,
                timestamp: new Date()
            });
        }

        logger.bridge('✅ Minecraft to Discord bridge setup completed');
    }

    /**
     * Setup Discord to Minecraft message bridging
     * 
     * Establishes event listeners on the Discord manager to handle messages
     * from Discord channels. Routes Discord messages to appropriate Minecraft
     * guild chats based on channel configuration.
     * 
     * Event listeners registered:
     * - onMessage: Discord channel messages
     * 
     * @private
     */
    setupDiscordToMinecraftBridge() {
        if (!this.discordManager) {
            logger.warn('Discord manager not available for bridge setup');
            return;
        }

        if (!this.minecraftManager) {
            logger.warn('Minecraft manager not available for bridge setup');
            return;
        }

        logger.debug('[BRIDGE] Setting up Discord to Minecraft event handlers...');

        // Handle Discord messages
        this.discordManager.onMessage((messageData) => {
            this.handleDiscordMessage(messageData)
                .catch(error => logger.logError(error, 'Unhandled error in handleDiscordMessage'));
        });

        logger.bridge('✅ Discord to Minecraft bridge setup completed');
    }

    /**
     * Handle Minecraft message (Minecraft to Discord bridging)
     * 
     * Processes Minecraft chat messages (guild or officer) and bridges them to Discord.
     * Validates Discord connection status and guild configuration before sending.
     * 
     * @async
     * @param {object} messageData - Minecraft message data
     * @param {string} messageData.guildId - Guild ID where message originated
     * @param {string} messageData.username - Username of message sender
     * @param {string} messageData.message - Message content
     * @param {string} messageData.chatType - Chat type ('guild' or 'officer')
     * 
     * @example
     * // Internal usage when Minecraft message is received
     * await coordinator.handleMinecraftMessage({
     *   guildId: "guild123",
     *   username: "Player123",
     *   message: "Hello world!",
     *   chatType: "guild"
     * });
     */
    async handleMinecraftMessage(messageData) {
        try {
            logger.debug(`[MC→DC] Processing message: ${JSON.stringify(messageData)}`);
            
            // Skip if Discord manager is not connected
            if (!this.discordManager.isConnected()) {
                metrics.dropped('mc_to_discord', 'discord_disconnected', `${messageData.username}: ${messageData.message}`);
                return;
            }

            // Get guild configuration
            const guildConfig = this.getGuildConfig(messageData.guildId);
            if (!guildConfig) {
                metrics.dropped('mc_to_discord', 'guild_config_missing', `guildId ${messageData.guildId}`);
                return;
            }

            logger.discord(`[MC→DC] Processing message from ${guildConfig.name}: ${messageData.username}`);

            // Send to Discord
            await this.discordManager.sendGuildMessage(messageData, guildConfig);

            logger.discord(`[MC→DC] ✅ Message successfully bridged to Discord`);

        } catch (error) {
            logger.logError(error, `Error bridging Minecraft message to Discord from guild ${messageData.guildId}`);
        }
    }

    /**
     * Handle Minecraft guild event (with double-logging prevention)
     * 
     * Processes Minecraft guild events and routes them to Discord. Implements smart
     * double-logging prevention by checking for active CommandResponseListener instances.
     * If a Discord command is actively listening for this event, skips the automatic
     * log to prevent duplicate messages.
     * 
     * Event flow:
     * 1. Send event to Discord chat channels (always)
     * 2. Check for active command listeners
     * 3. If no listener: Send to log channels
     * 4. If listener exists: Skip log (command response will handle it)
     * 
     * @async
     * @param {object} eventData - Parsed guild event data
     * @param {string} eventData.guildId - Guild ID where event occurred
     * @param {string} eventData.type - Event type (join, leave, promote, demote, etc.)
     * @param {string} [eventData.username] - Username involved in event
     * @param {string} [eventData.fromRank] - Previous rank (promote/demote)
     * @param {string} [eventData.toRank] - New rank (promote/demote)
     * @param {string} [eventData.raw] - Raw Minecraft message
     * 
     * @example
     * // Internal usage when guild event is detected
     * await coordinator.handleMinecraftEvent({
     *   guildId: "guild123",
     *   type: "promote",
     *   username: "Player123",
     *   fromRank: "Member",
     *   toRank: "Officer"
     * });
     */
    async handleMinecraftEvent(eventData) {
        try {
            logger.debug(`[MC→DC] Processing event: ${JSON.stringify(eventData)}`);
            
            // Skip if event bridging is disabled
            if (!this.routingConfig.eventsToDiscord) {
                logger.debug(`[MC→DC] Event bridging disabled, skipping event`);
                return;
            }

            // Get guild configuration
            const guildConfig = this.getGuildConfig(eventData.guildId);
            if (!guildConfig) {
                metrics.dropped('mc_to_discord', 'guild_config_missing', `event ${eventData.type}, guildId ${eventData.guildId}`);
                return;
            }

            logger.discord(`[MC→DC] Processing ${eventData.type} event from ${guildConfig.name}: ${eventData.username || 'system'}`);

            // Check if Discord manager is ready
            if (!this.discordManager.isConnected()) {
                logger.warn(`[MC→DC] Discord not connected, skipping event`);
                return;
            }

            // Send to Discord chat (existing functionality)
            logger.debug(`[MC→DC] Sending event to Discord chat...`);
            const result = await this.discordManager.sendGuildEvent(eventData, guildConfig);

            await this.sendDetectionNotification(eventData, guildConfig);

            // DOUBLE-LOGGING FIX: Check if there's an active Discord command listener for this event
            logger.debug(`[MC→DC] ================================`);
            logger.debug(`[MC→DC] DOUBLE-LOGGING CHECK START`);
            logger.debug(`[MC→DC] Event: ${eventData.type} - Player: ${eventData.username} - Guild: ${eventData.guildId}`);
            logger.debug(`[MC→DC] ================================`);
            
            const CommandResponseListener = require("../client/handlers/CommandResponseListener.js");
            
            // Check if CommandResponseListener class exists
            logger.debug(`[MC→DC] CommandResponseListener class available: ${!!CommandResponseListener}`);
            
            // Check if singleton instance exists
            logger.debug(`[MC→DC] CommandResponseListener.instance exists: ${!!CommandResponseListener.instance}`);
            
            // Try to get instance
            let instance = null;
            try {
                instance = CommandResponseListener.getInstance();
                logger.debug(`[MC→DC] Got singleton instance: ${!!instance}`);
            } catch (error) {
                logger.debug(`[MC→DC] Error getting singleton instance:`, error);
            }
            
            const hasActiveListener = CommandResponseListener.hasActiveListenerForEvent(eventData);
            logger.debug(`[MC→DC] ================================`);
            logger.debug(`[MC→DC] FINAL RESULT: hasActiveListener = ${hasActiveListener}`);
            logger.debug(`[MC→DC] ================================`);
            
            if (hasActiveListener) {
                logger.debug(`[MC→DC] ✅ Skipping event log - Discord command listener will handle logging for ${eventData.type} event`);
            } else {
                logger.debug(`[MC→DC] ❌ No active listener found - sending event log to Discord channels...`);
                await this.sendEventLog(eventData, guildConfig);
            }

            logger.discord(`[MC→DC] ✅ Event successfully bridged to Discord ${hasActiveListener ? 'without duplicate logging' : 'with logging'}`);

        } catch (error) {
            logger.logError(error, `Error bridging Minecraft event to Discord from guild ${eventData.guildId}`);
        }
    }

    /**
     * Handle Minecraft connection events
     * 
     * Processes bot connection status changes (connected, disconnected, reconnected)
     * and sends notifications to Discord status channels.
     * 
     * @async
     * @param {object} connectionData - Connection event data
     * @param {string} connectionData.guildId - Guild ID
     * @param {string} connectionData.type - Connection type (connected, disconnected, reconnected)
     * @param {object} [connectionData.details] - Additional connection details
     * 
     * @example
     * // Internal usage when connection status changes
     * await coordinator.handleMinecraftConnection({
     *   guildId: "guild123",
     *   type: "connected",
     *   details: { attempt: 1, connectionTime: "2:30 PM" }
     * });
     */
    async handleMinecraftConnection(connectionData) {
        try {
            logger.debug(`[MC→DC] Processing connection event: ${JSON.stringify(connectionData)}`);
            
            // Skip if Discord manager is not connected
            if (!this.discordManager.isConnected()) {
                logger.warn(`[MC→DC] Discord not connected, skipping connection event`);
                return;
            }

            // Get guild configuration
            const guildConfig = this.getGuildConfig(connectionData.guildId);
            if (!guildConfig) {
                logger.warn(`Guild configuration not found for connection event: ${connectionData.guildId}`);
                return;
            }

            logger.discord(`[MC→DC] Processing ${connectionData.type} connection event from ${guildConfig.name}`);

            // Send to Discord
            await this.discordManager.sendConnectionStatus(connectionData.guildId, connectionData.type, connectionData.details || {});

            logger.discord(`[MC→DC] ✅ Connection event successfully bridged to Discord`);

        } catch (error) {
            logger.logError(error, `Error bridging Minecraft connection event to Discord from guild ${connectionData.guildId}`);
        }
    }

    /**
     * Handle Discord message (Discord to Minecraft bridging)
     * 
     * Processes Discord channel messages and bridges them to all connected Minecraft guilds.
     * Implements comprehensive error tracking, delivery confirmation, and user feedback.
     * Sends messages to appropriate chat type (guild or officer) based on Discord channel type.
     * 
     * Success/failure tracking:
     * - Tracks delivery to each connected guild separately
     * - Reports partial failures with error reactions
     * - Provides detailed logging of success/failure counts
     * 
     * @async
     * @param {object} messageData - Discord message data
     * @param {object} messageData.author - Message author information
     * @param {string} messageData.author.displayName - Display name of author
     * @param {string} messageData.author.username - Username of author
     * @param {string} messageData.author.minecraftUsername - Minecraft username extracted from display name
     * @param {string} messageData.content - Message content
     * @param {string} messageData.channelType - Channel type ('chat' or 'staff')
     * @param {object} messageData.message - Discord.js message object for reactions
     * 
     * @example
     * // Internal usage when Discord message is received
     * await coordinator.handleDiscordMessage({
     *   author: { displayName: "User123", username: "user123" },
     *   content: "Hello from Discord!",
     *   channelType: "chat",
     *   message: discordMessageObject
     * });
     */
    async handleDiscordMessage(messageData) {
        let successCount = 0;
        let errorCount = 0;
        let connectedGuilds = [];

        try {
            logger.debug(`[DC→MC] Processing message: ${JSON.stringify(messageData)}`);
            
            // Skip if Discord to Minecraft bridging is disabled
            if (!this.routingConfig.discordToMinecraft) {
                logger.debug(`[DC→MC] Discord to Minecraft bridging disabled, skipping message`);
                return;
            }

            // Validate message data
            if (!messageData || !messageData.content || !messageData.author) {
                logger.debug(`[DC→MC] Invalid message data, skipping`);
                return;
            }

            // Check if Minecraft manager is ready
            if (!this.minecraftManager || !this.minecraftManager._isStarted) {
                const error = new Error('Minecraft manager not ready');
                await this.handleBridgeError(messageData, error, 0, 0);
                return;
            }

            // Extract Minecraft username from Discord server nickname
            try {
                if (messageData.messageRef && messageData.messageRef.guildId && messageData.author.id) {
                    // Find Discord client (try common property names)
                    const discordClient = this.discordManager.getClient();
                    
                    if (!discordClient) {
                        throw new Error('Discord client not found in BridgeCoordinator');
                    }
                    
                    // Fetch guild and member to get server nickname
                    const guild = await discordClient.guilds.fetch(messageData.messageRef.guildId);
                    const member = await guild.members.fetch(messageData.author.id);
                    const serverNickname = member.displayName;
                    
                    // Parse format: "[number] Username"
                    const minecraftUsernameMatch = serverNickname.match(/^\[\d+\]\s*(.+)$/);
                    if (minecraftUsernameMatch) {
                        messageData.author.minecraftUsername = minecraftUsernameMatch[1];
                        logger.debug(`[DC→MC] Extracted Minecraft username: ${messageData.author.minecraftUsername} from server nickname: ${serverNickname}`);
                    } else {
                        // Fallback to server nickname if format doesn't match
                        messageData.author.minecraftUsername = serverNickname;
                        logger.debug(`[DC→MC] Using server nickname as Minecraft username: ${serverNickname}`);
                    }
                } else {
                    // Fallback to Discord username if guild info not available
                    messageData.author.minecraftUsername = messageData.author.username;
                    logger.debug(`[DC→MC] Using Discord username as fallback: ${messageData.author.username}`);
                }
            } catch (error) {
                // Fallback to Discord username on error
                logger.logError(error, `Failed to fetch guild member for Minecraft username extraction`);
                messageData.author.minecraftUsername = messageData.author.username;
                logger.debug(`[DC→MC] Using Discord username as fallback after error: ${messageData.author.username}`);
            }

            // Determine target chat type based on Discord channel
            const chatType = this.determineChatTypeFromChannel(messageData.channelType);
            if (!chatType) {
                metrics.dropped('discord_to_mc', 'unknown_channel_type', `channelType ${messageData.channelType}`);
                return;
            }

            // Get connected Minecraft guilds
            connectedGuilds = this.minecraftManager.getConnectedGuilds();
            if (!connectedGuilds || connectedGuilds.length === 0) {
                const error = new Error('No connected Minecraft guilds available');
                await this.handleBridgeError(messageData, error, 0, 0);
                return;
            }

            // Format message for Minecraft
            const formattedMessage = this.formatDiscordMessageForMinecraft(messageData, chatType);
            
            logger.discord(`[DC→MC] Processing ${chatType} message from Discord: ${messageData.author.displayName} -> "${messageData.content}"`);

            // Send message to all connected guilds with error tracking
            const deliveryPromises = connectedGuilds.map(async (guildInfo) => {
                try {
                    await this.sendMessageToMinecraft(guildInfo.guildId, formattedMessage, chatType);
                    logger.bridge(`[DC→MC] ✅ ${chatType} message sent to ${guildInfo.guildName}`);
                    return { success: true, guildInfo };
                } catch (error) {
                    logger.logError(error, `Failed to send ${chatType} message to guild ${guildInfo.guildName}`);
                    return { success: false, guildInfo, error };
                }
            });

            // Wait for all deliveries to complete
            const results = await Promise.allSettled(deliveryPromises);
            
            // Count actual successes and failures
            successCount = 0;
            errorCount = 0;
            let firstError = null;

            results.forEach(result => {
                if (result.status === 'fulfilled') {
                    if (result.value.success) {
                        successCount++;
                    } else {
                        errorCount++;
                        if (!firstError) {
                            firstError = result.value.error || new Error('Unknown delivery error');
                        }
                    }
                } else {
                    errorCount++;
                    if (!firstError) {
                        firstError = result.reason || new Error('Unknown delivery error');
                    }
                }
            });

            if (errorCount > 0) {
                // Some deliveries failed
                await this.handleBridgeError(messageData, firstError, successCount, connectedGuilds.length);
            } else {
                // All deliveries confirmed written to the server, not merely requested
                metrics.sent('discord_to_mc', 'all_guilds');
                logger.discord(`[DC→MC] ✅ Discord message bridged successfully to all ${connectedGuilds.length} Minecraft guilds`);
            }

        } catch (error) {
            logger.logError(error, `Unexpected error bridging Discord message to Minecraft`);
            await this.handleBridgeError(messageData, error, successCount, connectedGuilds.length);
        }
    }

    /**
     * Send detection notification to detection channel
     * 
     * Sends a notification to the configured detection channel for join, leave,
     * promote, and demote events. The message includes:
     * - Join/Leave: player username and guild name
     * - Promote/Demote: player username and new rank
     * 
     * @async
     * @param {object} eventData - Event data from Minecraft
     * @param {string} eventData.type - Event type (join, leave, promote, demote)
     * @param {string} eventData.username - Player username
     * @param {string} [eventData.toRank] - New rank (for promote/demote)
     * @param {object} guildConfig - Guild configuration
     * @param {string} guildConfig.name - Guild name
     */
    async sendDetectionNotification(eventData, guildConfig) {
        try {
            // Only send notifications for specific event types
            const notifiableEvents = ['welcome', 'leave', 'kick', 'promote', 'demote'];
            if (!notifiableEvents.includes(eventData.type)) {
                return;
            }

            // Get detection channel ID from config
            const detectionChannelId = this.config.get('features.detection.channelId');
            if (!detectionChannelId) {
                logger.warn('[DETECTION] Detection channel not configured, skipping notification');
                return;
            }

            // Get Discord client
            const discordManager = BridgeLocator.getInstance().getDiscordManager();
            if (!discordManager || !discordManager.getClient()) {
                logger.warn('[DETECTION] Discord manager not available, skipping detection notification');
                return;
            }

            // Fetch detection channel
            const detectionChannel = await discordManager.getClient().channels.fetch(detectionChannelId);
            if (!detectionChannel) {
                logger.warn(`[DETECTION] Detection channel not found: ${detectionChannelId}`);
                return;
            }

            // Build notification message based on event type
            let notificationMessage = '';
            
            switch (eventData.type) {
                case 'welcome':
                    notificationMessage = `[GUILD JOIN] ${eventData.username} joined ${guildConfig.name}`;
                    break;
                    
                case 'leave':
                    notificationMessage = `[GUILD LEAVE] ${eventData.username} left ${guildConfig.name}`;
                    break;

                case 'kick': {
                    // Attach the reason from the Discord /guild kick command if this kick
                    // originated there (in-game kicks have no reason). FrenchLegacy-Discord
                    // parses this to DM the kicked player.
                    const kickReason = kickReasonStore.take(guildConfig.id, eventData.username);
                    notificationMessage = `[GUILD KICK] ${eventData.username} kicked from ${guildConfig.name}`;
                    if (kickReason) {
                        notificationMessage += ` | Reason: ${kickReason}`;
                    }
                    break;
                }

                case 'promote':
                    notificationMessage = `[GUILD PROMOTE] ${eventData.username} was promoted to ${eventData.toRank || 'Unknown Rank'} in ${guildConfig.name}`;
                    break;
                    
                case 'demote':
                    notificationMessage = `[GUILD DEMOTE] ${eventData.username} was demoted to ${eventData.toRank || 'Unknown Rank'} in ${guildConfig.name}`;
                    break;
            }

            // Send notification to detection channel
            await detectionChannel.send(notificationMessage);
            logger.debug(`[DETECTION] Sent ${eventData.type} notification for ${eventData.username} in ${guildConfig.name}`);

        } catch (error) {
            logger.logError(error, `Failed to send detection notification for ${eventData.type} event`);
        }
    }

    /**
     * Determine chat type from Discord channel type
     * 
     * Maps Discord channel types to Minecraft chat types. Used to route Discord
     * messages to the appropriate Minecraft chat (/gc for guild, /oc for officer).
     * 
     * @param {string} channelType - Discord channel type identifier
     * @returns {string|null} Minecraft chat type ('guild', 'officer', or null if unknown)
     * 
     * @example
     * determineChatTypeFromChannel('chat'); // Returns: 'guild'
     * determineChatTypeFromChannel('staff'); // Returns: 'officer'
     * determineChatTypeFromChannel('unknown'); // Returns: null
     */
    determineChatTypeFromChannel(channelType) {
        switch (channelType) {
            case 'chat':
                return 'guild';
            case 'staff':
                return 'officer';
            default:
                return null;
        }
    }

    /**
     * Format Discord message for Minecraft
     * 
     * Formats a Discord message for display in Minecraft guild chat. Adds a
     * "D >" prefix to distinguish bridged messages from native Minecraft chat.
     * 
     * Format: `D > Username: message content`
     * 
     * @param {object} messageData - Discord message data
     * @param {object} messageData.author - Message author
     * @param {string} messageData.author.displayName - Display name
     * @param {string} messageData.author.username - Username fallback
     * @param {string} messageData.content - Message content
     * @param {string} chatType - Target chat type (currently not used in formatting)
     * @returns {string} Formatted message for Minecraft
     * 
     * @example
     * const formatted = formatDiscordMessageForMinecraft({
     *   author: { displayName: "User123" },
     *   content: "Hello world!"
     * }, 'guild');
     * // Returns: "D > User123: Hello world!"
     */
    formatDiscordMessageForMinecraft(messageData, chatType) {
        const username = messageData.author.minecraftUsername || messageData.author.displayName || messageData.author.username;
        const content = messageData.content;
        
        // Add Discord prefix to distinguish from native Minecraft messages
        const prefix = "D >";
        
        // Format: D > Username: message content
        return `${prefix} ${username}: ${content}`;
    }

    /**
     * Send message to Minecraft guild
     * 
     * Sends a formatted message to a specific Minecraft guild using the appropriate
     * guild chat command (/gc for guild chat, /oc for officer chat).
     * 
     * @async
     * @param {string} guildId - Guild ID to send message to
     * @param {string} message - Formatted message to send
     * @param {string} chatType - Chat type ('guild' or 'officer')
     * @throws {Error} If message delivery fails
     * 
     * @example
     * await coordinator.sendMessageToMinecraft(
     *   "guild123",
     *   "Discord > User: Hello!",
     *   "guild"
     * );
     */
    async sendMessageToMinecraft(guildId, message, chatType) {
        try {
            // For officer chat, use /oc command, for guild chat use /gc command
            const command = chatType === 'officer' ? `/oc ${message}` : `/gc ${message}`;
            
            // Use executeCommand instead of sendMessage for proper guild chat commands
            await this.minecraftManager.executeCommand(guildId, command);
            
        } catch (error) {
            logger.logError(error, `Failed to send ${chatType} message to guild ${guildId}`);
            throw error;
        }
    }

    /**
     * Send event log to Discord channel
     * 
     * Sends a formatted embed log of a guild event to the appropriate Discord log channel.
     * Automatically determines the correct channel based on event type and configuration.
     * Creates a rich embed with event details, player information with UUID, and formatting
     * matching the command response style.
     * 
     * @async
     * @param {object} eventData - Event data from Minecraft
     * @param {string} eventData.type - Event type (join, leave, promote, demote, etc.)
     * @param {string} [eventData.username] - Username involved in event
     * @param {string} [eventData.raw] - Raw Minecraft message
     * @param {object} guildConfig - Guild configuration
     * @param {string} guildConfig.name - Guild name
     * 
     * @example
     * // Internal usage when event needs logging
     * await coordinator.sendEventLog({
     *   type: "promote",
     *   username: "Player123",
     *   fromRank: "Member",
     *   toRank: "Officer",
     *   raw: "[GUILD] Player123 was promoted to Officer"
     * }, guildConfig);
     */
    async sendEventLog(eventData, guildConfig) {
        try {
            const mainBridge = BridgeLocator.getInstance();
            const discordManager = mainBridge.getDiscordManager?.();
            
            if (!discordManager || !discordManager.isConnected()) {
                logger.debug('Discord manager not available for event logging');
                return;
            }

            // Get Discord bot client
            const client = discordManager._discordBot?.getClient();
            if (!client) {
                logger.debug('Discord client not available for event logging');
                return;
            }

            // Get log channels configuration
            const config = mainBridge.config;
            const logChannels = config.get('discord.logChannels');
            if (!logChannels) {
                logger.debug('No log channels configured for event logging');
                return;
            }

            // Determine which channel to use based on event type
            const channelId = this.getEventLogChannel(eventData.type, logChannels);
            
            if (!channelId || channelId.trim() === '') {
                logger.debug(`No log channel configured for event type: ${eventData.type}`);
                return;
            }

            // Get the channel
            const channel = await client.channels.fetch(channelId).catch(() => null);
            if (!channel) {
                logger.warn(`Could not find Discord log channel: ${channelId}`);
                return;
            }

            if(eventData.type !== "online") {
                // Create embed for the event log
                const embed = await this.createEventLogEmbed(eventData, guildConfig);
                // Send the log
                await channel.send({ embeds: [embed] });
            }

            logger.discord(`[EVENT-LOG] Logged ${eventData.type} event to Discord channel ${channel.name}`);

        } catch (error) {
            logger.logError(error, `Failed to send event log to Discord for ${eventData.type} event`);
        }
    }

    /**
     * Handle a failed or partial Discord to Minecraft delivery
     *
     * Reports a bridging failure back to the Discord user who sent the message and
     * records it in the metrics. Distinguishes a total failure (nothing was delivered)
     * from a partial one (some guilds received the message, others did not) so the
     * reaction reflects what actually happened.
     *
     * This method previously did not exist while being called from four places in this
     * class. Every call threw a TypeError, and because one of those calls sits inside
     * the catch block of handleDiscordMessage, the TypeError escaped the async function
     * as an unhandled rejection - which main.js turns into process.exit(1). Any partial
     * delivery failure therefore killed the whole bridge.
     *
     * @async
     * @param {object} messageData - Discord message data being bridged
     * @param {object} [messageData.messageRef] - Discord.js message object for reactions
     * @param {object} messageData.author - Message author information
     * @param {Error} error - The error that caused the failure
     * @param {number} successCount - Number of guilds that received the message
     * @param {number} totalGuilds - Number of guilds that should have received it
     *
     * @example
     * await coordinator.handleBridgeError(messageData, error, 2, 3);
     * // Adds a ⚠️ reaction: 2 of 3 guilds got the message
     */
    async handleBridgeError(messageData, error, successCount, totalGuilds) {
        try {
            const isPartial = successCount > 0 && successCount < totalGuilds;
            const reason = isPartial ? 'partial_delivery' : 'delivery_failed';

            metrics.dropped(
                'discord_to_mc',
                reason,
                `${successCount}/${totalGuilds} guilds - ${error?.message || 'unknown error'}`
            );

            if (isPartial) {
                logger.warn(
                    `[DC→MC] Partial delivery: ${successCount}/${totalGuilds} guilds received the message ` +
                    `from ${messageData?.author?.username || 'unknown'} - ${error?.message || 'unknown error'}`
                );
            } else {
                logger.warn(
                    `[DC→MC] Delivery failed for message from ${messageData?.author?.username || 'unknown'} ` +
                    `- ${error?.message || 'unknown error'}`
                );
            }

            // Give the sender visible feedback: ⚠️ when it partly went through,
            // ❌ when nothing did
            const reaction = isPartial ? '⚠️' : '❌';
            const target = messageData?.messageRef || messageData?.message;

            if (target && typeof target.react === 'function') {
                await target.react(reaction);
            }

        } catch (reactionError) {
            // Never let error reporting become a new source of failure - this method is
            // called from inside catch blocks
            logger.debug(`Failed to report bridge error to Discord: ${reactionError.message}`);
        }
    }

    /**
     * Get appropriate log channel for event type
     * 
     * Maps event types to their configured Discord log channels. Falls back to
     * default channel if no specific channel is configured for an event type.
     * 
     * Channel mapping:
     * - join/invite → invite channel
     * - leave/kick → kick channel
     * - promote → promote channel
     * - demote → demote channel
     * - setrank → setrank channel
     * - level/motd/misc → default channel
     * 
     * @param {string} eventType - Type of event
     * @param {object} logChannels - Log channels configuration object
     * @param {string} [logChannels.invite] - Invite/join events channel
     * @param {string} [logChannels.kick] - Kick/leave events channel
     * @param {string} [logChannels.promote] - Promote events channel
     * @param {string} [logChannels.demote] - Demote events channel
     * @param {string} [logChannels.setrank] - Setrank events channel
     * @param {string} logChannels.default - Default fallback channel
     * @returns {string} Channel ID to use for logging
     * 
     * @example
     * const channelId = coordinator.getEventLogChannel('promote', {
     *   promote: "123456789",
     *   default: "987654321"
     * });
     * // Returns: "123456789"
     */
    getEventLogChannel(eventType, logChannels) {
        // Map event types to channel configurations
        const eventChannelMap = {
            'join': logChannels.invite || logChannels.default,
            'leave': logChannels.kick || logChannels.default, 
            'kick': logChannels.kick || logChannels.default,
            'promote': logChannels.promote || logChannels.default,
            'demote': logChannels.demote || logChannels.default,
            'setrank': logChannels.setrank || logChannels.default,
            'invite': logChannels.invite || logChannels.default,
            'level': logChannels.default,
            'motd': logChannels.default,
            'misc': logChannels.default
        };

        return eventChannelMap[eventType] || logChannels.default;
    }

    /**
     * Create Discord embed for event log (matching command log format)
     * 
     * Creates a rich Discord embed for event logging with formatting that matches
     * command response embeds. Includes guild information, player details with UUID
     * fetching, and event-specific details.
     * 
     * Embed structure:
     * - Title: "✅ {EventType} Event Detected"
     * - Color: Green (success)
     * - Fields: Guild, Target Player (with UUID), Details
     * - Footer: "🔧 Guild Event System"
     * 
     * @async
     * @param {object} eventData - Event data
     * @param {string} eventData.type - Event type
     * @param {string} [eventData.username] - Player username
     * @param {string} [eventData.raw] - Raw event message
     * @param {object} guildConfig - Guild configuration
     * @param {string} guildConfig.name - Guild name
     * @returns {EmbedBuilder} Discord embed ready to send
     * 
     * @example
     * const embed = await coordinator.createEventLogEmbed({
     *   type: "promote",
     *   username: "Player123",
     *   fromRank: "Member",
     *   toRank: "Officer"
     * }, guildConfig);
     */
    async createEventLogEmbed(eventData, guildConfig) {
        const { EmbedBuilder } = require('discord.js');
        
        // Use green color like successful commands (events detected are always "successful")
        const statusColor = 0x00FF00; // Green
        const statusEmoji = '✅';

        const embed = new EmbedBuilder()
            .setTitle(`${statusEmoji} ${this.capitalizeFirst(eventData.type)} Event Detected`)
            .setColor(statusColor)
            .setTimestamp()
            .setFooter({ text: '🔧 Guild Event System' });

        // Add guild information (same format as commands)
        embed.addFields({ 
            name: '🏰 Guild', 
            value: `**${guildConfig.name}**`, 
            inline: false 
        });

        // Add player information if available (equivalent to "Target Player")
        if (eventData.username && eventData.username !== 'system') {
            let playerValue = `\`${eventData.username}\``;
            
            try {
                const uuid = await fetchMinecraftUUID(eventData.username);
                if (uuid) {
                    // Format UUID with dashes (xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx)
                    const formattedUUID = uuid.replace(/(.{8})(.{4})(.{4})(.{4})(.{12})/, '$1-$2-$3-$4-$5');
                    playerValue = `\`${eventData.username}\` • \`${formattedUUID}\``;
                }
            } catch (error) {
                logger.debug(`Failed to fetch UUID for ${eventData.username}`, error);
            }
        
            embed.addFields({ 
                name: '🎯 Target Player', 
                value: playerValue, 
                inline: false 
            });
        }

        // Add event details (equivalent to "Response")
        const eventDetails = this.buildEventDetails(eventData);
        embed.addFields({
            name: '📝 Details',
            value: eventDetails,
            inline: false
        });

        return embed;
    }

    /**
     * Build event details string (matching command response format)
     * 
     * Constructs a formatted details string for event embeds based on event type.
     * Includes rank changes, levels, reasons, and raw messages when available.
     * 
     * @param {object} eventData - Event data
     * @param {string} eventData.type - Event type
     * @param {string} [eventData.fromRank] - Previous rank
     * @param {string} [eventData.toRank] - New rank
     * @param {string} [eventData.rank] - Rank (for setrank)
     * @param {number} [eventData.level] - Guild level
     * @param {string} [eventData.reason] - Kick/leave reason
     * @param {string} [eventData.raw] - Raw Minecraft message
     * @returns {string} Formatted event details string
     * 
     * @example
     * const details = coordinator.buildEventDetails({
     *   type: "promote",
     *   fromRank: "Member",
     *   toRank: "Officer",
     *   raw: "[GUILD] Player was promoted"
     * });
     * // Returns: "**Rank Change:** Member → Officer\n**Raw Message:** `[GUILD] Player was promoted`"
     */
    buildEventDetails(eventData) {
        let details = [];

        // Add event-specific information
        switch (eventData.type) {
            case 'promote':
            case 'demote':
                if (eventData.fromRank && eventData.toRank) {
                    details.push(`**Rank Change:** ${eventData.fromRank} → ${eventData.toRank}`);
                }
                break;
                
            case 'setrank':
                if (eventData.rank) {
                    details.push(`**New Rank:** ${eventData.rank}`);
                }
                break;
                
            case 'level':
                if (eventData.level) {
                    details.push(`**Guild Level:** ${eventData.level}`);
                }
                break;
                
            case 'kick':
                if (eventData.reason) {
                    details.push(`**Reason:** ${eventData.reason}`);
                }
                break;
        }

        // Add raw message if available (formatted like command logs)
        if (eventData.raw) {
            const rawMessage = eventData.raw.length > 500 ? eventData.raw.substring(0, 500) + '...' : eventData.raw;
            details.push(`**Raw Message:** \`${rawMessage}\``);
        }

        return details.length > 0 ? details.join('\n') : 'Event detected successfully';
    }

    /**
     * Capitalize first letter of a string
     * 
     * Simple utility function to capitalize the first character of a string
     * for display purposes in embeds and messages.
     * 
     * @param {string} str - String to capitalize
     * @returns {string} String with first letter capitalized, or empty string if input is falsy
     * 
     * @example
     * capitalizeFirst('promote'); // Returns: 'Promote'
     * capitalizeFirst('guild_join'); // Returns: 'Guild_join'
     * capitalizeFirst(''); // Returns: ''
     */
    capitalizeFirst(str) {
        if (!str) return '';
        return str.charAt(0).toUpperCase() + str.slice(1);
    }

    /**
     * Get guild configuration by guild ID
     * 
     * Retrieves guild configuration from the config system by guild ID.
     * Returns null if guild is not found or if an error occurs.
     * 
     * @param {string} guildId - Guild ID to look up
     * @returns {object|null} Guild configuration object or null if not found
     * 
     * @example
     * const guildConfig = coordinator.getGuildConfig("guild123");
     * if (guildConfig) {
     *   console.log(`Found guild: ${guildConfig.name}`);
     * }
     */
    getGuildConfig(guildId) {
        try {
            const guildConfigs = this.config.get('guilds') || [];
            return guildConfigs.find(guild => guild.id === guildId) || null;
        } catch (error) {
            return null;
        }
    }

    /**
     * Add error reaction to Discord message
     * 
     * Adds a ❌ reaction to a Discord message to indicate an error occurred.
     * Used for user feedback when message bridging fails. Fails silently if
     * reaction cannot be added.
     * 
     * @async
     * @param {object} messageData - Discord message data
     * @param {object} messageData.message - Discord.js message object
     * 
     * @example
     * // Internal usage when bridge error occurs
     * await coordinator.addErrorReaction(messageData);
     */
    async addErrorReaction(messageData) {
        try {
            if (messageData.message && typeof messageData.message.react === 'function') {
                await messageData.message.react('❌');
            }
        } catch (error) {
            logger.debug('Failed to add error reaction:', error);
        }
    }

    /**
     * Cleanup all listeners
     * 
     * Performs cleanup of all coordinator resources, including command response
     * listeners, manager references, and routing configuration. Should be called
     * when shutting down the bridge to ensure clean resource release.
     * 
     * Cleanup operations:
     * - Cleans up CommandResponseListener singleton
     * - Nullifies manager references
     * - Resets routing configuration to defaults
     * 
     * @example
     * // During shutdown
     * coordinator.cleanup();
     */
    cleanup() {
        try {
            try {
                if (CommandResponseListener.instance) {
                    CommandResponseListener.instance.cleanup();
                }
            } catch (error) {
                logger.error('Error cleaning up CommandResponseListener:', error);
            }
            
            // Reset manager references
            if (this.discordManager) {
                this.discordManager = null;
            }
            
            if (this.minecraftManager) {
                this.minecraftManager = null;
            }
            
            // Reset routing configuration to defaults
            this.routingConfig = {
                guildChatToDiscord: true,
                officerChatToDiscord: true,
                eventsToDiscord: true,
                discordToMinecraft: true,
                systemMessagesToDiscord: true
            };
            
            logger.bridge('✅ BridgeCoordinator cleanup completed');
            
        } catch (error) {
            logger.logError(error, 'Error during BridgeCoordinator cleanup');
        }
    }

    /**
     * Get current routing configuration
     * 
     * Returns a copy of the current routing configuration object. This is
     * useful for checking which routing paths are currently enabled.
     * 
     * @returns {object} Current routing configuration (copy)
     * @returns {boolean} return.guildChatToDiscord - Guild chat bridging enabled
     * @returns {boolean} return.officerChatToDiscord - Officer chat bridging enabled
     * @returns {boolean} return.eventsToDiscord - Event bridging enabled
     * @returns {boolean} return.discordToMinecraft - Discord to MC bridging enabled
     * @returns {boolean} return.systemMessagesToDiscord - System messages bridging enabled
     * 
     * @example
     * const config = coordinator.getRoutingConfig();
     * if (config.discordToMinecraft) {
     *   console.log("Discord to Minecraft bridging is enabled");
     * }
     */
    getRoutingConfig() {
        return { ...this.routingConfig };
    }
}

/**
 * Fetch Minecraft UUID from Mojang API
 * 
 * External utility function that fetches a player's UUID from the Mojang API
 * using their username. Returns the UUID without dashes. Used for player
 * identification in event logs.
 * 
 * @async
 * @param {string} username - Minecraft username to look up
 * @returns {Promise<string|null>} UUID without dashes, or null if not found/error
 * 
 * @example
 * const uuid = await fetchMinecraftUUID("Player123");
 * if (uuid) {
 *   console.log(`UUID: ${uuid}`);
 *   // Format with dashes: uuid.replace(/(.{8})(.{4})(.{4})(.{4})(.{12})/, '$1-$2-$3-$4-$5')
 * }
 */
async function fetchMinecraftUUID(username) {
    try {
        const response = await fetch(`https://api.mojang.com/users/profiles/minecraft/${username}`);
        if (response.ok) {
            const data = await response.json();
            return data.id;
        }
    } catch (error) {
        logger.debug(`Could not fetch UUID for player ${username}`, error);
    }
    return null;
}

module.exports = BridgeCoordinator;