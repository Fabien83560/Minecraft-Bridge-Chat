/**
 * Command Response Listener - Discord Command Response Tracking System
 * 
 * This file handles tracking and validation of Discord slash commands executed in Minecraft.
 * It creates listeners that monitor Minecraft chat and events for command responses, validates
 * success/error patterns, and provides feedback to Discord users. The system prevents duplicate
 * logging of events and ensures accurate command result tracking.
 * 
 * The listener provides:
 * - Singleton pattern for centralized command response tracking
 * - Active listener management for pending Discord commands
 * - Pattern-based response validation (success/error detection)
 * - Event matching between Minecraft events and Discord commands
 * - Anti-duplicate logging with recently resolved listener tracking
 * - Automatic timeout handling for unresponsive commands
 * - Discord logging integration for command execution results
 * - Raw message interception from Minecraft bot connections
 * - UUID fetching for command target players
 * 
 * Response Pattern System:
 * - Configurable regex patterns for each command type
 * - Success pattern matching for command confirmation
 * - Error pattern matching for command failure detection
 * - Target player validation in responses
 * - Special handling for global commands (mute/unmute everyone)
 * 
 * Event Matching:
 * - Maps Minecraft events to Discord command types
 * - Supports event types: promote, demote, kick, join, leave, mute, unmute
 * - Handles setrank command generating promote/demote events
 * - Guild-specific event filtering
 * - Player-specific event matching
 * 
 * Anti-Duplicate System:
 * - Tracks recently resolved listeners for 5 seconds
 * - Prevents double logging of the same event
 * - Automatic cleanup of old resolved listeners
 * 
 * @author Fabien83560
 * @version 1.0.0
 * @license ISC
 */

// Globals Imports
const EventEmitter = require('events');

// Specific Imports
const BridgeLocator = require("../../../bridgeLocator.js");
const { getPatternLoader } = require("../../../config/PatternLoader.js");
const logger = require("../../../shared/logger");

/**
 * CommandResponseListener - Tracks Discord command responses from Minecraft
 * 
 * Implements singleton pattern to provide centralized command response tracking.
 * Extends EventEmitter to emit command result events for external handling.
 * 
 * @class
 * @extends EventEmitter
 */
class CommandResponseListener extends EventEmitter {
    /**
     * Create a new CommandResponseListener instance
     * 
     * Implements singleton pattern - returns existing instance if already created.
     * Initializes listener tracking, response patterns, and anti-duplicate system.
     */
    constructor() {
        super();
        
        // Singleton pattern implementation
        if (CommandResponseListener.instance) {
            return CommandResponseListener.instance;
        }
        CommandResponseListener.instance = this;
        
        // Store reference in prototype for external access
        CommandResponseListener.prototype._instance = this;
        
        this.activeListeners = new Map();
        this.listenerCounter = 0;
        
        // Track recently resolved listeners to prevent double logging
        this.recentlyResolvedListeners = new Map(); // Map<listenerId, resolvedData>
        this.RECENTLY_RESOLVED_TIMEOUT = 5000; // 5 seconds
        
        // Response patterns for different command types
        this.responsePatterns = {};
        
        // Load patterns from configuration
        this.loadResponsePatterns();

        logger.debug('CommandResponseListener initialized with singleton pattern');
    }

    // ==================== SINGLETON ACCESS ====================

    /**
     * Get singleton instance
     * 
     * Returns the singleton instance of CommandResponseListener.
     * Creates new instance if none exists.
     * 
     * @static
     * @returns {CommandResponseListener} Singleton instance
     */
    static getInstance() {
        if (!CommandResponseListener.instance) {
            CommandResponseListener.instance = new CommandResponseListener();
        }
        return CommandResponseListener.instance;
    }

    // ==================== EVENT MATCHING SYSTEM ====================

    /**
     * Static method to check if there's an active listener for a specific event
     * 
     * Used by BridgeCoordinator to determine if an event should be suppressed from
     * normal logging because it's being tracked by a Discord command listener.
     * Checks both active listeners and recently resolved listeners to prevent
     * duplicate logging within the timeout window.
     * 
     * @static
     * @param {object} eventData - Event data from Minecraft
     * @param {string} eventData.type - Event type (promote, demote, kick, etc.)
     * @param {string} eventData.username - Player username involved in event
     * @param {string} eventData.guildId - Guild ID where event occurred
     * @returns {boolean} True if there's an active listener that will handle this event
     */
    static hasActiveListenerForEvent(eventData) {
        try {
            // Get singleton instance
            const instance = CommandResponseListener.getInstance();
            
            if (!instance) {
                logger.warning('[CMD-LISTENER] No singleton instance available');
                return false;
            }

            const activeListeners = instance.getActiveListeners();
            const recentlyResolved = instance.recentlyResolvedListeners;
            
            // Clean up old recently resolved listeners
            instance.cleanupOldResolvedListeners();
            
            // Log all active listeners
            let listenerIndex = 0;
            for (const [listenerId, listener] of activeListeners) {
                listenerIndex++;
            }
            
            // Log recently resolved listeners
            listenerIndex = 0;
            for (const [listenerId, resolvedData] of recentlyResolved) {
                listenerIndex++;
            }
            
            logger.debug(`[CMD-LISTENER] Checking ${activeListeners.size} active + ${recentlyResolved.size} recently resolved listeners for event: ${eventData.type} - ${eventData.username || 'system'} in guild ${eventData.guildId}`);
            
            // Check active listeners first
            for (const [listenerId, listener] of activeListeners) {
                if (instance.checkListenerMatch(listenerId, listener, eventData, "ACTIVE")) {
                    return true;
                }
            }
            
            // Check recently resolved listeners
            for (const [listenerId, resolvedData] of recentlyResolved) {
                if (instance.checkListenerMatch(listenerId, resolvedData, eventData, "RECENTLY_RESOLVED")) {
                    return true;
                }
            }
            
            return false;
            
        } catch (error) {
            logger.error('[CMD-LISTENER] Error checking for active command listeners:', error);
            return false;
        }
    }

    /**
     * Check if a listener matches an event
     * 
     * Validates if a listener (active or recently resolved) should handle a specific event.
     * Performs guild matching, resolution status check, event type matching, and player matching.
     * 
     * @param {string} listenerId - Listener ID
     * @param {object} listenerData - Listener data (active or resolved)
     * @param {object} eventData - Event data from Minecraft
     * @param {string} listenerType - "ACTIVE" or "RECENTLY_RESOLVED"
     * @returns {boolean} True if matches
     */
    checkListenerMatch(listenerId, listenerData, eventData, listenerType) {
        logger.debug(`[CMD-LISTENER] Analyzing ${listenerType} listener ${listenerId}`);
        
        // Skip if different guild
        if (listenerData.guildId !== eventData.guildId) {
            return false;
        }
        
        // For active listeners, skip if already resolved
        if (listenerType === "ACTIVE" && listenerData.resolved) {
            return false;
        }
        
        // Check if this event type matches the command type
        const isMatchingEvent = this.isEventMatchingCommand(eventData, listenerData);
        
        if (isMatchingEvent) {            
            // Check if the target player matches (if applicable)
            if (eventData.username && listenerData.targetPlayer) {
                const eventPlayerLower = eventData.username.toLowerCase();
                const targetPlayerLower = listenerData.targetPlayer.toLowerCase();
                
                
                if (eventPlayerLower === targetPlayerLower) {
                    return true;
                } else {
                    logger.debug(`[CMD-LISTENER]   ❌ Player mismatch: "${eventPlayerLower}" vs "${targetPlayerLower}"`);
                }
            } else if (!eventData.username || !listenerData.targetPlayer) {
                // For events without specific players or commands without targets
                return true;
            } else {
                logger.debug(`[CMD-LISTENER]   ❌ One has player, other doesn't - event: ${!!eventData.username}, listener: ${!!listenerData.targetPlayer}`);
            }
        } else {
            logger.debug(`[CMD-LISTENER]   ❌ Event type doesn't match command type`);
        }
        
        return false;
    }

    /**
     * Clean up old recently resolved listeners
     * 
     * Removes resolved listeners that have exceeded the timeout window.
     * Prevents memory leaks and ensures the recently resolved map stays current.
     * 
     * @private
     */
    cleanupOldResolvedListeners() {
        const now = Date.now();
        const toRemove = [];
        
        for (const [listenerId, resolvedData] of this.recentlyResolvedListeners) {
            if (now - resolvedData.resolvedAt > this.RECENTLY_RESOLVED_TIMEOUT) {
                toRemove.push(listenerId);
            }
        }
        
        for (const listenerId of toRemove) {
            this.recentlyResolvedListeners.delete(listenerId);
        }
    }

    /**
     * Check if an event type matches a command type
     * 
     * Maps Minecraft event types to Discord command types.
     * Handles special cases like setrank generating promote/demote events.
     * 
     * Event to Command Mapping:
     * - promote → promote, setrank
     * - demote → demote, setrank
     * - kick → kick
     * - join → invite
     * - leave → kick (leave events can be caused by kicks)
     * - mute → mute
     * - unmute → unmute
     * 
     * @param {object} eventData - Event data from Minecraft
     * @param {object} listener - Command listener
     * @returns {boolean} True if they match
     */
    isEventMatchingCommand(eventData, listener) {
        const eventToCommandMap = {
            'promote': ['promote', 'setrank'], // setrank can generate promote events
            'demote': ['demote', 'setrank'],   // setrank can generate demote events
            'kick': ['kick'],
            'join': ['invite'],
            'leave': ['kick'], // Leave events can be caused by kicks
            'setrank': ['setrank'], // Keep original setrank mapping
            'mute': ['mute'],
            'unmute': ['unmute']
        };

        const matchingCommands = eventToCommandMap[eventData.type] || [];
        const isMatch = matchingCommands.includes(listener.commandType);
        
        // Debug log for setrank cases
        if (listener.commandType === 'setrank' || eventData.type === 'promote' || eventData.type === 'demote') {
            logger.debug(`[CMD-LISTENER] Event-Command mapping check: event="${eventData.type}" vs command="${listener.commandType}" → match=${isMatch}`);
            logger.debug(`[CMD-LISTENER] Available commands for event "${eventData.type}": [${matchingCommands.join(', ')}]`);
        }
        
        return isMatch;
    }

    /**
     * Get active listeners map (for external access by BridgeCoordinator)
     * 
     * @returns {Map} Active listeners map
     */
    getActiveListeners() {
        return this.activeListeners;
    }

    // ==================== PATTERN LOADING ====================

    /**
     * Load response patterns from configuration
     * 
     * Loads and compiles regex patterns for command response detection.
     * Patterns are loaded from the PatternLoader configuration for the Hypixel server.
     * Converts JSON pattern strings to RegExp objects with case-insensitive matching.
     * 
     * @private
     */
    loadResponsePatterns() {
        try {
            // Initialize with empty object first
            this.responsePatterns = {};
            
            const patternLoader = getPatternLoader();
            const commandsResponseConfig = patternLoader.getCommandsResponsePatterns('Hypixel');
            
            if (!commandsResponseConfig) {
                logger.warn('No commands response patterns found for Hypixel');
                return;
            }

            // Convert JSON patterns to RegExp objects
            for (const [commandType, patterns] of Object.entries(commandsResponseConfig)) {
                this.responsePatterns[commandType] = {
                    success: [],
                    error: []
                };

                // Convert success patterns
                if (patterns.success) {
                    for (const patternConfig of patterns.success) {
                        try {
                            // Use flags from pattern config, default to 'i' for case insensitive
                            const regex = new RegExp(patternConfig.pattern, 'i');
                            this.responsePatterns[commandType].success.push({
                                pattern: regex,
                                groups: patternConfig.groups || [],
                                description: patternConfig.description || 'No description'
                            });
                        } catch (error) {
                            logger.logError(error, `Failed to compile success pattern for ${commandType}: ${patternConfig.pattern}`);
                        }
                    }
                }

                // Convert error patterns
                if (patterns.error) {
                    for (const patternConfig of patterns.error) {
                        try {
                            // Use flags from pattern config, default to 'i' for case insensitive
                            const regex = new RegExp(patternConfig.pattern, 'i');
                            this.responsePatterns[commandType].error.push({
                                pattern: regex,
                                groups: patternConfig.groups || [],
                                description: patternConfig.description || 'No description'
                            });
                        } catch (error) {
                            logger.logError(error, `Failed to compile error pattern for ${commandType}: ${patternConfig.pattern}`);
                        }
                    }
                }
            }

            logger.debug(`Loaded command response patterns for: ${Object.keys(this.responsePatterns).join(', ')}`);

        } catch (error) {
            logger.logError(error, 'Failed to load command response patterns');
        }
    }

    // ==================== LISTENER CREATION ====================

    /**
     * Create a new command listener
     * 
     * Creates a listener that monitors Minecraft chat and events for command responses.
     * Automatically attaches to Minecraft message system and sets up timeout handling.
     * 
     * @param {string} guildId - Guild ID to listen to
     * @param {string} commandType - Type of command (invite, kick, etc.)
     * @param {string} targetPlayer - Player being targeted by the command
     * @param {string} command - Full command string executed
     * @param {number} timeoutMs - Timeout in milliseconds (default: 10000)
     * @param {object} interaction - Discord interaction object (optional)
     * @returns {string} Listener ID
     */
    createListener(guildId, commandType, targetPlayer, command, timeoutMs = 10000, interaction = null) {
        const listenerId = `cmd_${++this.listenerCounter}_${Date.now()}`;
        
        const listener = {
            id: listenerId,
            guildId: guildId,
            command: command,
            commandType: commandType.toLowerCase(),
            targetPlayer: targetPlayer,
            createdAt: Date.now(),
            timeout: null,
            resolved: false,
            messageHandler: null,
            eventHandler: null,
            rawMessageHandler: null,
            interaction: interaction
        };

        // Set up timeout
        listener.timeout = setTimeout(() => {
            this.resolveListener(listenerId, {
                success: false,
                error: 'Command timeout - no response received',
                type: 'timeout'
            });
        }, timeoutMs);

        // Set up message handler
        listener.messageHandler = (messageData) => {
            this.handleMessage(listenerId, messageData);
        };

        // Set up event handler
        listener.eventHandler = (eventData) => {
            this.handleEvent(listenerId, eventData);
        };

        // Store listener
        this.activeListeners.set(listenerId, listener);

        // Attach to Minecraft message system
        this.attachToMinecraftMessages(listener);

        logger.debug(`Created command listener ${listenerId} for ${commandType} on ${guildId} targeting ${targetPlayer}`);

        return listenerId;
    }

    /**
     * Attach listener to Minecraft message system
     * 
     * Connects the listener to both raw Minecraft bot messages and guild events.
     * Raw messages bypass normal filtering to ensure command responses are caught.
     * 
     * @private
     * @param {object} listener - Listener configuration
     */
    attachToMinecraftMessages(listener) {
        try {
            const mainBridge = BridgeLocator.getInstance();
            const minecraftManager = mainBridge.getMinecraftManager?.();
            
            if (!minecraftManager) {
                throw new Error('MinecraftManager not available');
            }

            // Listen to ALL raw messages from the specific bot connection
            const botManager = minecraftManager._botManager;
            if (!botManager) {
                throw new Error('BotManager not available');
            }

            // Get the specific connection for this guild
            const connection = botManager.connections.get(listener.guildId);
            if (!connection) {
                throw new Error(`No connection found for guild: ${listener.guildId}`);
            }

            // Listen to raw messages directly from the bot connection
            listener.rawMessageHandler = (message) => {
                this.handleRawMessage(listener.id, message, listener.guildId);
            };

            // Attach to the bot's message event
            const bot = connection._bot;
            if (bot) {
                bot.on('message', listener.rawMessageHandler);
                logger.debug(`Attached listener ${listener.id} to raw messages from bot`);
            }

            // Also listen to events (for kick, promote, demote events)  
            minecraftManager.onEvent(listener.eventHandler);

            logger.debug(`Attached listener ${listener.id} to Minecraft raw message and event systems`);

        } catch (error) {
            logger.logError(error, `Failed to attach listener ${listener.id} to Minecraft messages`);
            this.resolveListener(listener.id, {
                success: false,
                error: 'Failed to attach message listener',
                type: 'system_error'
            });
        }
    }

    // ==================== MESSAGE HANDLING ====================

    /**
     * Handle incoming raw Minecraft message (bypasses guild message filtering)
     * 
     * Processes raw messages from Minecraft bot to detect command responses.
     * Applies pattern matching for success and error cases.
     * Includes special validation logic for mute/unmute commands.
     * 
     * @private
     * @param {string} listenerId - Listener ID
     * @param {object} message - Raw message from Minecraft bot
     * @param {string} guildId - Guild ID for context
     */
    handleRawMessage(listenerId, message, guildId) {
        const listener = this.activeListeners.get(listenerId);
        
        if (!listener || listener.resolved) {
            return;
        }

        // Convert message to string and clean it
        const messageText = message.toString ? message.toString() : String(message);
        const cleanMessage = messageText.replace(/§[0-9a-fklmnor]/g, '').trim();
        
        logger.debug(`[${listenerId}] Processing raw message: "${cleanMessage}"`);
        
        // Ensure patterns exist for this command type
        if (!this.responsePatterns || !this.responsePatterns[listener.commandType]) {
            logger.warn(`No response patterns found for command type: ${listener.commandType}`);
            return;
        }
        
        const patterns = this.responsePatterns[listener.commandType];

        // Check for success patterns
        if (patterns.success && Array.isArray(patterns.success)) {
            for (let i = 0; i < patterns.success.length; i++) {
                const patternObj = patterns.success[i];
                const match = cleanMessage.match(patternObj.pattern);
                
                if (match) {
                    logger.debug(`[${listenerId}] Success pattern ${i} matched: ${patternObj.description}`);
                    logger.debug(`[${listenerId}] Match groups:`, match.slice(1));
                    
                    // Apply command-specific validation
                    let isValidMatch = false;
                    
                    if (listener.commandType === 'mute' || listener.commandType === 'unmute') {
                        if (listener.targetPlayer === 'everyone') {
                            // For global commands, check if it's a guild-wide pattern
                            isValidMatch = cleanMessage.includes('guild chat');
                            logger.debug(`[${listenerId}] Global command - guild chat check: ${isValidMatch}`);
                        } else {
                            // For player-specific commands, check if target matches
                            const extractedTarget = match[2] ? match[2].toLowerCase() : null;
                            isValidMatch = extractedTarget && extractedTarget === listener.targetPlayer.toLowerCase();
                            logger.debug(`[${listenerId}] Player command - target "${extractedTarget}" vs "${listener.targetPlayer}": ${isValidMatch}`);
                        }
                    } else {
                        // For other command types, use original logic
                        const extractedPlayer = match[1] ? match[1].toLowerCase() : null;
                        isValidMatch = !extractedPlayer || extractedPlayer === listener.targetPlayer.toLowerCase();
                        logger.debug(`[${listenerId}] Other command - player match: ${isValidMatch}`);
                    }
                    
                    if (isValidMatch) {
                        logger.debug(`[${listenerId}] ✅ Success pattern validated! Resolving listener.`);
                        this.resolveListener(listenerId, {
                            success: true,
                            message: cleanMessage,
                            type: 'success',
                            extractedData: {
                                fullMatch: match[0],
                                groups: match.slice(1),
                                patternDescription: patternObj.description
                            }
                        });
                        return;
                    } else {
                        logger.debug(`[${listenerId}] Pattern matched but validation failed - continuing to next pattern`);
                    }
                } else {
                    logger.debug(`[${listenerId}] Success pattern ${i} did not match`);
                }
            }
        }

        // Check for error patterns
        if (patterns.error && Array.isArray(patterns.error)) {
            for (let i = 0; i < patterns.error.length; i++) {
                const patternObj = patterns.error[i];
                const match = cleanMessage.match(patternObj.pattern);
                
                if (match) {
                    logger.debug(`[${listenerId}] ❌ Error pattern ${i} matched: ${patternObj.description}`);
                    this.resolveListener(listenerId, {
                        success: false,
                        error: cleanMessage,
                        type: 'command_error',
                        extractedData: {
                            fullMatch: match[0],
                            groups: match.slice(1),
                            patternDescription: patternObj.description
                        }
                    });
                    return;
                }
            }
        }
        
        logger.debug(`[${listenerId}] No patterns matched for message: "${cleanMessage}"`);
    }

    /**
     * Handle incoming Minecraft message
     * 
     * Delegates to handleRawMessage for consistency.
     * 
     * @private
     * @param {string} listenerId - Listener ID
     * @param {object} messageData - Message data from Minecraft
     */
    handleMessage(listenerId, messageData) {
        // Just delegate to handleRawMessage for consistency
        const message = messageData.message || messageData.toString();
        this.handleRawMessage(listenerId, message, messageData.guildId);
    }

    /**
     * Handle incoming Minecraft event
     * 
     * Processes guild events (kick, join, promote, demote) that match the listener's
     * command type and target player. Resolves the listener on successful match.
     * 
     * @private
     * @param {string} listenerId - Listener ID
     * @param {object} eventData - Event data from Minecraft
     */
    handleEvent(listenerId, eventData) {
        const listener = this.activeListeners.get(listenerId);
        
        if (!listener || listener.resolved) {
            return;
        }

        // Only process events from the correct guild
        if (eventData.guildId !== listener.guildId) {
            return;
        }

        // Only process relevant event types
        if (!this.isEventMatchingCommand(eventData, listener)) {
            return;
        }

        // Check if the target player matches
        const eventPlayer = eventData.username ? eventData.username.toLowerCase() : null;
        if (!eventPlayer || eventPlayer !== listener.targetPlayer) {
            return;
        }

        logger.debug(`Event detected for listener ${listenerId}: ${eventData.type} - ${eventData.username}`);

        // For kick events, this is a success
        if (eventData.type === 'kick' && listener.commandType === 'kick') {
            this.resolveListener(listenerId, {
                success: true,
                message: `${eventData.username} was kicked from the guild`,
                type: 'success',
                extractedData: {
                    player: eventData.username,
                    event: eventData
                }
            });
            return;
        }

        // For invite events, this could be either success (join) or failure
        if (eventData.type === 'join' && listener.commandType === 'invite') {
            this.resolveListener(listenerId, {
                success: true,
                message: `${eventData.username} joined the guild`,
                type: 'success',
                extractedData: {
                    player: eventData.username,
                    event: eventData
                }
            });
            return;
        }

        // For promote/demote events
        if ((eventData.type === 'promote' && listener.commandType === 'promote') ||
            (eventData.type === 'demote' && listener.commandType === 'demote')) {
            this.resolveListener(listenerId, {
                success: true,
                message: `${eventData.username} was ${eventData.type}d`,
                type: 'success',
                extractedData: {
                    player: eventData.username,
                    event: eventData
                }
            });
            return;
        }
    }

    // ==================== LISTENER RESOLUTION ====================

    /**
     * Resolve a listener with a result
     * 
     * Marks a listener as resolved, cleans up handlers, stores in recently resolved
     * for anti-duplicate tracking, and emits the result. Sends Discord log on success.
     * 
     * @private
     * @param {string} listenerId - Listener ID
     * @param {object} result - Result object with success, message/error, and type
     */
    resolveListener(listenerId, result) {
        const listener = this.activeListeners.get(listenerId);
        
        if (!listener || listener.resolved) {
            return;
        }

        listener.resolved = true;

        // Store in recently resolved listeners for double-logging prevention
        this.recentlyResolvedListeners.set(listenerId, {
            guildId: listener.guildId,
            commandType: listener.commandType,
            targetPlayer: listener.targetPlayer,
            resolvedAt: Date.now(),
            result: result
        });
        
        logger.debug(`[CMD-LISTENER] Added to recently resolved listeners: ${listenerId} (${listener.commandType} - ${listener.targetPlayer})`);

        // Clear timeout
        if (listener.timeout) {
            clearTimeout(listener.timeout);
        }

        // Send command log to Discord if successful
        if (result.success) {
            this.sendCommandLog(listener, result);
        }

        // Remove message handlers
        try {
            const mainBridge = BridgeLocator.getInstance();
            const minecraftManager = mainBridge.getMinecraftManager?.();
            
            if (minecraftManager) {
                // Remove raw message handler from bot
                if (listener.rawMessageHandler) {
                    try {
                        const botManager = minecraftManager._botManager;
                        const connection = botManager?.connections?.get(listener.guildId);
                        const bot = connection?._bot;
                        
                        if (bot) {
                            bot.removeListener('message', listener.rawMessageHandler);
                            logger.debug(`Removed raw message handler for listener ${listenerId}`);
                        }
                    } catch (error) {
                        logger.logError(error, `Failed to remove raw message handler for listener ${listenerId}`);
                    }
                }
                
                logger.debug(`Detached listener ${listenerId} from message and event systems`);
            }
        } catch (error) {
            logger.logError(error, `Failed to detach listener ${listenerId}`);
        }

        // Remove from active listeners
        this.activeListeners.delete(listenerId);

        // Emit result
        this.emit('commandResult', {
            listenerId: listenerId,
            guildId: listener.guildId,
            commandType: listener.commandType,
            targetPlayer: listener.targetPlayer,
            result: result,
            duration: Date.now() - listener.createdAt
        });

        logger.debug(`Resolved listener ${listenerId} with result: ${JSON.stringify(result)}`);
    }

    // ==================== DISCORD LOGGING ====================

    /**
     * Send command log to Discord channel
     * 
     * Creates and sends an embed message to Discord logging channel with command
     * execution details including executor, guild, target player, command, and result.
     * Fetches Minecraft UUID for target player and formats embed with appropriate
     * colors and emojis based on success/failure.
     * 
     * @async
     * @private
     * @param {object} listener - Listener configuration
     * @param {object} result - Command result
     */
    async sendCommandLog(listener, result) {
        try {
            const mainBridge = BridgeLocator.getInstance();
            const discordManager = mainBridge.getDiscordManager?.();
            
            if (!discordManager || !discordManager.isConnected()) {
                logger.debug('Discord manager not available for command logging');
                return;
            }

            // Get Discord bot client
            const client = discordManager._discordBot?.getClient();
            if (!client) {
                logger.debug('Discord client not available for command logging');
                return;
            }

            // Get log channels configuration
            const config = mainBridge.config;
            const logChannels = config.get('discord.logChannels');
            if (!logChannels) {
                logger.debug('No log channels configured');
                return;
            }

            // Determine which channel to use
            const commandChannelId = logChannels[listener.commandType];
            const channelId = commandChannelId && commandChannelId.trim() !== '' 
                ? commandChannelId 
                : logChannels.default;

            if (!channelId || channelId.trim() === '') {
                logger.debug(`No log channel configured for command type: ${listener.commandType}`);
                return;
            }

            // Get the channel
            const channel = await client.channels.fetch(channelId).catch(() => null);
            if (!channel) {
                logger.warn(`Could not find Discord log channel: ${channelId}`);
                return;
            }

            // Get guild name for the log
            const guilds = config.get('guilds') || [];
            const guildConfig = guilds.find(g => g.id === listener.guildId);
            const guildName = guildConfig ? guildConfig.name : listener.guildId;

            // Create embed for the log
            const { EmbedBuilder } = require('discord.js');

            // Determine status color and emoji based on result
            const isSuccess = !result.error;
            const statusColor = isSuccess ? 0x00FF00 : 0xFF0000; // Green for success, red for error
            const statusEmoji = isSuccess ? '✅' : '❌';

            const embed = new EmbedBuilder()
                .setTitle(`${statusEmoji} ${this.capitalizeFirst(listener.commandType)} Command ${isSuccess ? 'Executed' : 'Failed'}`)
                .setColor(statusColor)
                .setTimestamp()
                .setFooter({ text: '🔧 Guild Command System' });

            // Add executor information first if available
            if (listener.interaction) {
                try {
                    const executor = listener.interaction.user;
                    if (executor) {
                        embed.addFields({ 
                            name: '👤 Executed By', 
                            value: `<@${executor.id}> (**${executor.id}**)`, 
                            inline: false 
                        });
                    }
                } catch (error) {
                    logger.debug('Could not retrieve interaction details for command log', error);
                }
            }

            // Fetch Minecraft UUID for target player
            let targetPlayerValue = `\`${listener.targetPlayer}\``;
            if(listener.targetPlayer != "everyone") {
                try {
                    const uuid = await fetchMinecraftUUID(listener.targetPlayer);
                    if (uuid) {
                        // Format UUID with dashes (xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx)
                        const formattedUUID = uuid.replace(/(.{8})(.{4})(.{4})(.{4})(.{12})/, '$1-$2-$3-$4-$5');
                        targetPlayerValue = `\`${listener.targetPlayer}\` • \`${formattedUUID}\``;
                    }
                } catch (error) {
                    logger.debug(`Failed to fetch UUID for ${listener.targetPlayer}`, error);
                }
            }

            // Add command details section
            embed.addFields(
                { 
                    name: '🏰 Guild', 
                    value: `**${guildName}**`, 
                    inline: false 
                },
                { 
                    name: '🎯 Target Player', 
                    value: targetPlayerValue, 
                    inline: false 
                },
                { 
                    name: '💻 Command', 
                    value: `${listener.command}`, 
                    inline: false 
                }
            );

            // Add response/error message
            const responseTitle = isSuccess ? '📝 Response' : '⚠️ Error Details';
            const responseValue = result.error 
                ? `\`\`\`${result.error}\`\`\`` 
                : (result.message || 'Command completed successfully');

            embed.addFields({
                name: responseTitle,
                value: responseValue,
                inline: false
            });

            // Send the log message
            await channel.send({ embeds: [embed] });
            
            logger.debug(`Command log sent to Discord channel ${channelId} for ${listener.commandType} command`);

        } catch (error) {
            logger.logError(error, 'Failed to send command log to Discord');
        }
    }

    /**
     * Capitalize first letter of a string
     * 
     * @private
     * @param {string} str - String to capitalize
     * @returns {string} Capitalized string
     */
    capitalizeFirst(str) {
        if (!str) return '';
        return str.charAt(0).toUpperCase() + str.slice(1);
    }

    // ==================== LISTENER MANAGEMENT ====================

    /**
     * Cancel a listener
     * 
     * Manually cancels an active listener and resolves it with cancelled status.
     * 
     * @param {string} listenerId - Listener ID
     * @returns {boolean} True if listener was found and cancelled
     */
    cancelListener(listenerId) {
        const listener = this.activeListeners.get(listenerId);
        
        if (!listener) {
            return false;
        }

        this.resolveListener(listenerId, {
            success: false,
            error: 'Command cancelled by user',
            type: 'cancelled'
        });

        return true;
    }

    /**
     * Wait for a command result
     * 
     * Returns a promise that resolves when the specified listener completes.
     * Used by command handlers to await command execution results.
     * 
     * @param {string} listenerId - Listener ID
     * @returns {Promise<object>} Command result
     */
    waitForResult(listenerId) {
        return new Promise((resolve) => {
            const handleResult = (data) => {
                if (data.listenerId === listenerId) {
                    this.removeListener('commandResult', handleResult);
                    resolve(data.result);
                }
            };

            this.on('commandResult', handleResult);

            // Check if already resolved
            if (!this.activeListeners.has(listenerId)) {
                this.removeListener('commandResult', handleResult);
                resolve({
                    success: false,
                    error: 'Listener not found or already resolved',
                    type: 'not_found'
                });
            }
        });
    }

    /**
     * Get active listeners count
     * 
     * @returns {number} Number of active listeners
     */
    getActiveListenersCount() {
        return this.activeListeners.size;
    }

    /**
     * Get statistics
     * 
     * Returns comprehensive statistics about listener usage including
     * active count, breakdown by guild, breakdown by type, and total created.
     * 
     * @returns {object} Statistics object
     */
    getStatistics() {
        const listeners = Array.from(this.activeListeners.values());
        
        return {
            activeListeners: listeners.length,
            listenersByGuild: listeners.reduce((acc, listener) => {
                acc[listener.guildId] = (acc[listener.guildId] || 0) + 1;
                return acc;
            }, {}),
            listenersByType: listeners.reduce((acc, listener) => {
                acc[listener.commandType] = (acc[listener.commandType] || 0) + 1;
                return acc;
            }, {}),
            totalCreated: this.listenerCounter
        };
    }

    // ==================== CLEANUP ====================

    /**
     * Cleanup all listeners
     * 
     * Cancels all active listeners and removes all event listeners.
     * Should be called before disposing of the handler instance.
     */
    cleanup() {
        for (const [listenerId] of this.activeListeners) {
            this.cancelListener(listenerId);
        }
        
        this.removeAllListeners();
        logger.debug('CommandResponseListener cleaned up');
    }
}

// ==================== UTILITY FUNCTIONS ====================

/**
 * Function to fetch Minecraft UUID from Mojang API
 * 
 * Retrieves the UUID for a given Minecraft username using Mojang's API.
 * Used for enhanced Discord logging with player identifiers.
 * 
 * @async
 * @param {string} username - Minecraft username
 * @returns {Promise<string|null>} UUID if found, null otherwise
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

module.exports = CommandResponseListener;