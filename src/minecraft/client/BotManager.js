/**
 * Bot Manager - Central Minecraft Bot Connection Management
 * 
 * This file serves as the central orchestrator for all Minecraft bot connections,
 * managing their lifecycle, message processing, and inter-guild communication.
 * It extends EventEmitter to provide event-driven architecture for connection
 * and message handling.
 * 
 * Key responsibilities:
 * - Connection lifecycle management (start, stop, reconnect)
 * - Automatic reconnection with exponential backoff
 * - Guild message filtering and routing
 * - Inter-guild message coordination
 * - Event emission for connection, message, and error events
 * - Connection status monitoring and reporting
 * - Message sending to guild and officer chats
 * 
 * The BotManager coordinates between:
 * - MinecraftConnection: Individual bot connections
 * - MessageCoordinator: Message parsing and formatting
 * - InterGuildManager: Cross-guild message relaying
 * - Bridge system: Integration with Discord and other platforms
 * 
 * Architecture:
 * - Uses Map for O(1) connection lookups by guild ID
 * - Event-driven design for loose coupling with bridge system
 * - Centralized error handling and logging
 * - Automatic recovery from connection failures
 * 
 * Events emitted:
 * - 'message': Guild chat messages
 * - 'event': Guild events (joins, leaves, promotions, etc.)
 * - 'connection': Connection state changes (connected, disconnected, reconnected)
 * - 'error': Connection and processing errors
 * 
 * @author Fabien83560
 * @version 1.0.0
 * @license ISC
 */

// Globals Imports
const EventEmitter = require('events');

// Specific Imports
const BridgeLocator = require("../../bridgeLocator.js");
const MinecraftConnection = require("./connection.js");
const MessageCoordinator = require("../client/parsers/MessageCoordinator.js");
const InterGuildManager = require("../../shared/InterGuildManager.js");
const logger = require("../../shared/logger");

/**
 * BotManager - Manages all Minecraft bot connections
 * 
 * Central orchestrator for bot connections, message processing, and inter-guild
 * communication. Extends EventEmitter for event-driven architecture.
 * 
 * @class
 * @extends EventEmitter
 */
class BotManager extends EventEmitter {
    /**
     * Initialize the bot manager
     * 
     * Sets up:
     * - Configuration from main bridge
     * - Connection map for all guilds
     * - Reconnection timer tracking
     * - Message coordinator for parsing
     * - Inter-guild manager for cross-guild communication
     * 
     * Automatically initializes connections for all enabled guilds.
     * 
     * @example
     * const botManager = new BotManager();
     * await botManager.startAll();
     */
    constructor() {
        super();

        const mainBridge = BridgeLocator.getInstance();
        this.config = mainBridge.config;

        this.connections = new Map();
        this.reconnectTimers = new Map();
        this.messageCoordinator = new MessageCoordinator();
        this.interGuildManager = new InterGuildManager();

        // Guilds that were intentionally disconnected by a user action.
        // Automatic reconnection is suppressed for guilds in this set.
        this.manuallyDisconnected = new Set();

        this.initialize();
    }

    /**
     * Initialize connections for all enabled guilds
     * 
     * Creates MinecraftConnection instances for each enabled guild and
     * sets up message callbacks for guild message handling.
     * Does not start connections - call startAll() to connect.
     * 
     * @returns {Promise<void>}
     * 
     * @example
     * await botManager.initialize();
     * console.log('All connections initialized');
     */
    async initialize() {
        const enabledGuilds = this.config.getEnabledGuilds();

        enabledGuilds.forEach(guild => {
            const connection = new MinecraftConnection(guild);
            
            // Set up callbacks for guild messages
            connection.setMessageCallback((rawMessage, guildMessageData) => {
                this.handleGuildMessage(guild.id, rawMessage, guildMessageData);
            });
            
            this.connections.set(guild.id, connection);

            logger.info(`Connection initialized for ${guild.name}`);
        });
    }

    /**
     * Start all guild connections
     * 
     * Attempts to start all initialized connections in parallel using Promise.allSettled.
     * Logs success/failure summary and emits connection events.
     * Throws error if no connections succeed.
     * 
     * Connection process for each guild:
     * 1. Establish connection
     * 2. Setup monitoring
     * 3. Emit 'connection' event
     * 4. Schedule reconnection on failure
     * 
     * @returns {Promise<void>}
     * @throws {Error} If all connections fail to start
     * 
     * @example
     * await botManager.startAll();
     * console.log('All bots connected');
     */
    async startAll() {
        const connectionPromises = [];

        for(const [guildId, connection] of this.connections) {
            const promise = this.startConnection(guildId);
            connectionPromises.push(promise);
        }

        const results = await Promise.allSettled(connectionPromises);

        let successCount = 0;
        let failCount = 0;

        results.forEach((result, index) => {
            const guildId = Array.from(this.connections.keys())[index];
            const guildName = this.connections.get(guildId).getGuildConfig().name;

            if (result.status === "fulfilled") {
                successCount++;
                logger.minecraft(`✅ Connection started for ${guildName}`);
            } else {
                failCount++;
                logger.logError(result.reason, `Failed to start connection for ${guildName}`);
            }
        });

        logger.minecraft(`✅ Connection summary: ${successCount} successful, ${failCount} failed`);
        
        if (successCount === 0) {
            throw new Error('Failed to start any Minecraft connections');
        }
    }

    /**
     * Start connection for a specific guild
     * 
     * Establishes connection, sets up monitoring, and emits connection event.
     * Schedules automatic reconnection if connection fails.
     * 
     * @param {string} guildId - Guild ID to connect
     * @returns {Promise<void>}
     * @throws {Error} If connection fails or guild not found
     * 
     * @example
     * await botManager.startConnection('guild1');
     * console.log('Guild connected');
     */
    async startConnection(guildId) {
        const connection = this.connections.get(guildId);
        if (!connection) {
            throw new Error(`No connection found for guild: ${guildId}`);
        }

        try {
            await connection.connect();
            this.setupConnectionMonitoring(guildId);
            
            // Emit connection event
            this.emit('connection', {
                type: 'connected',
                guildId: guildId,
                guildName: connection.getGuildConfig().name,
                username: connection.getGuildConfig().account.username
            });
        
        } catch (error) {
            logger.logError(error, `Failed to start connection for guild: ${guildId}`);
            
            // Schedule reconnection if enabled
            this.scheduleReconnection(guildId);
            throw error;
        }
    }

    /**
     * Setup connection monitoring for automatic reconnection
     * 
     * Monitors bot for:
     * - Disconnections: Schedules automatic reconnection
     * - Errors: Emits error events
     * 
     * Note: Message handling is done via callbacks set in initialize(),
     * not monitored here.
     * 
     * @param {string} guildId - Guild ID to monitor
     * 
     * @example
     * botManager.setupConnectionMonitoring('guild1');
     */
    setupConnectionMonitoring(guildId) {
        const connection = this.connections.get(guildId);
        if (!connection)
            return;

        const bot = connection.getBot();
        if (!bot)
            return;

        // Monitor for disconnections
        bot.on('end', (reason) => {
            logger.minecraft(`Connection ended for ${connection.getGuildConfig().name}: ${reason}`);
            
            this.emit('connection', {
                type: 'disconnected',
                guildId: guildId,
                guildName: connection.getGuildConfig().name,
                reason: reason
            });

            // Schedule reconnection
            this.scheduleReconnection(guildId);
        });

        bot.on('error', (error) => {
            logger.logError(error, `Connection error for ${connection.getGuildConfig().name}`);
            
            this.emit('error', error, guildId);
        });

        // Note: Message handling is now done via callbacks in connection.js
        // We don't need to monitor messages here anymore
    }

    /**
     * Handle guild messages that have been filtered by the strategy
     * 
     * Processing pipeline:
     * 1. Validate guild connection exists
     * 2. Parse message through MessageCoordinator
     * 3. Add strategy metadata
     * 4. Handle inter-guild processing if needed
     * 5. Emit appropriate event (message or event)
     * 
     * Only processes messages that passed strategy filtering (guild-related).
     * Logs all processing steps with [GUILD] prefix for clarity.
     * 
     * @param {string} guildId - Guild ID
     * @param {object} rawMessage - Raw message from Minecraft
     * @param {object} guildMessageData - Processed guild message data from strategy
     * @param {string} guildMessageData.type - Message type (GUILD_CHAT, OFFICER_CHAT, etc.)
     * @param {string} guildMessageData.category - Category (chat, event, system)
     * @param {string} guildMessageData.subtype - Subtype (guild, officer, join, etc.)
     * @param {boolean} guildMessageData.needsInterGuildProcessing - Whether to relay inter-guild
     * 
     * @example
     * botManager.handleGuildMessage(
     *   'guild1',
     *   rawMessage,
     *   { type: 'GUILD_CHAT', category: 'chat', needsInterGuildProcessing: true }
     * );
     */
    handleGuildMessage(guildId, rawMessage, guildMessageData) {
        const connection = this.connections.get(guildId);
        if (!connection) {
            logger.warn(`Received message for unknown guild: ${guildId}`);
            return;
        }

        const guildConfig = connection.getGuildConfig();
        
        // Log that we're processing a confirmed guild message
        logger.bridge(`[GUILD] [${guildConfig.name}] Processing confirmed guild message: ${guildMessageData.type}`);
        
        try {
            // Process the guild message through the coordinator
            const result = this.messageCoordinator.processMessage(rawMessage, guildConfig);
            
            // Add the strategy data to the result
            result.strategyData = guildMessageData;
            
            // Log the processing result with [GUILD] prefix
            logger.bridge(`[GUILD] [${guildConfig.name}] Message processed - Category: ${result.category}, Type: ${result.data.type || 'unknown'}`);
            
            // Handle inter-guild processing for messages and events
            this.handleInterGuildProcessing(result, guildConfig, guildMessageData);
            
            // Emit the appropriate event based on category
            if (result.category === 'message') {
                logger.bridge(`[GUILD] [${guildConfig.name}] Emitting message event - Username: ${result.data.username || 'unknown'}, Message: "${result.data.message || 'N/A'}"`);
                this.emit('message', result.data);
            } else if (result.category === 'event') {
                logger.bridge(`[GUILD] [${guildConfig.name}] Emitting event - Type: ${result.data.type}, Username: ${result.data.username || 'system'}`);
                this.emit('event', result.data);
            } else {
                // Log other categories but still with [GUILD] prefix since it came from strategy
                logger.bridge(`[GUILD] [${guildConfig.name}] Other category: ${result.category} - ${result.data.type || 'unknown'}`);
            }
            
        } catch (error) {
            logger.logError(error, `Error processing guild message for ${guildConfig.name}`);
        }
    }

    /**
     * Handle inter-guild processing for messages and events
     * 
     * Routes messages and events to InterGuildManager for cross-guild relaying.
     * Only processes if:
     * - needsInterGuildProcessing flag is true
     * - Message is guild chat OR
     * - Event was successfully parsed
     * 
     * @param {object} result - Processed message/event result from MessageCoordinator
     * @param {string} result.category - Result category ('message' or 'event')
     * @param {object} result.data - Parsed data with type and content
     * @param {object} guildConfig - Guild configuration
     * @param {object} guildMessageData - Strategy message data
     * @param {boolean} guildMessageData.needsInterGuildProcessing - Whether to process
     * @returns {Promise<void>}
     * 
     * @example
     * await botManager.handleInterGuildProcessing(
     *   { category: 'message', data: { type: 'guild_chat', message: 'Hello' } },
     *   guildConfig,
     *   { needsInterGuildProcessing: true }
     * );
     */
    async handleInterGuildProcessing(result, guildConfig, guildMessageData) {
        try {
            // Only process if inter-guild is enabled and this message needs processing
            if (!guildMessageData.needsInterGuildProcessing) {
                return;
            }

            if (result.category === 'message' && result.data.type === 'guild_chat') {
                // Process guild chat message for inter-guild transfer
                await this.interGuildManager.processGuildMessage(result.data, guildConfig, this);
                
            } else if (result.category === 'event' && result.data.parsedSuccessfully) {
                // Process guild event for inter-guild transfer
                await this.interGuildManager.processGuildEvent(result.data, guildConfig, this);
            }
            
        } catch (error) {
            logger.logError(error, `Error in inter-guild processing for ${guildConfig.name}`);
        }
    }

    /**
     * Schedule automatic reconnection for a guild
     * 
     * Schedules reconnection with delay from guild configuration.
     * Clears any existing reconnection timer before scheduling new one.
     * Respects reconnection.enabled flag - no reconnection if disabled.
     * 
     * On reconnection:
     * - Calls connection.reconnect()
     * - Re-establishes monitoring
     * - Emits 'reconnected' event
     * - Schedules another reconnection on failure
     * 
     * @param {string} guildId - Guild ID to reconnect
     * 
     * @example
     * botManager.scheduleReconnection('guild1');
     * // Reconnection scheduled based on guild config
     */
    scheduleReconnection(guildId) {
        const connection = this.connections.get(guildId);
        if (!connection)
            return;

        const guildConfig = connection.getGuildConfig();

        // Skip auto-reconnection for manually disconnected guilds
        if (this.manuallyDisconnected.has(guildId)) {
            logger.minecraft(`Skipping auto-reconnection for ${guildConfig.name} (manual disconnect)`);
            return;
        }

        const reconnectionConfig = guildConfig.account.reconnection;

        // Check if reconnection is enabled
        if (!reconnectionConfig || !reconnectionConfig.enabled) {
            logger.minecraft(`Reconnection disabled for ${guildConfig.name}`);
            return;
        }

        // Clear existing timer if any
        if (this.reconnectTimers.has(guildId)) {
            clearTimeout(this.reconnectTimers.get(guildId));
        }

        // Calculate delay
        const delay = reconnectionConfig.retryDelay || 30000;
        
        logger.minecraft(`Scheduling reconnection for ${guildConfig.name} in ${delay}ms`);

        const timer = setTimeout(async () => {
            try {
                logger.minecraft(`Attempting reconnection for ${guildConfig.name}`);
                await connection.reconnect();
                
                // Setup monitoring again
                this.setupConnectionMonitoring(guildId);
                
                this.emit('connection', {
                    type: 'reconnected',
                    guildId: guildId,
                    guildName: guildConfig.name,
                    username: guildConfig.account.username
                });
                
            } catch (error) {
                logger.logError(error, `Reconnection failed for ${guildConfig.name}`);
                this.scheduleReconnection(guildId);
            }
        }, delay);

        this.reconnectTimers.set(guildId, timer);
    }

    /**
     * Manually disconnect a guild bot
     *
     * Adds the guild to the manuallyDisconnected set (preventing auto-reconnect),
     * cancels any pending reconnect timer, disconnects the bot, and emits a
     * 'manual_disconnect' connection event.
     *
     * @async
     * @param {string} guildId - Guild ID to disconnect
     * @returns {Promise<void>}
     */
    async manualStop(guildId) {
        const connection = this.connections.get(guildId);
        if (!connection) {
            throw new Error(`No connection found for guild: ${guildId}`);
        }

        const guildConfig = connection.getGuildConfig();

        // Mark before disconnect so scheduleReconnection (if triggered) skips this guild
        this.manuallyDisconnected.add(guildId);

        // Cancel any pending auto-reconnect timer
        if (this.reconnectTimers.has(guildId)) {
            clearTimeout(this.reconnectTimers.get(guildId));
            this.reconnectTimers.delete(guildId);
        }

        // Disconnect (bot.removeAllListeners() is called inside, so 'end' won't re-trigger)
        await connection.disconnect();

        this.emit('connection', {
            type: 'manual_disconnect',
            guildId,
            guildName: guildConfig.name,
            username: guildConfig.account.username
        });

        logger.minecraft(`Manual disconnect executed for ${guildConfig.name}`);
    }

    /**
     * Manually reconnect a guild bot
     *
     * Removes the guild from the manuallyDisconnected set, cancels any pending
     * reconnect timer, establishes a fresh connection, and emits a
     * 'manual_reconnect' connection event.
     *
     * @async
     * @param {string} guildId - Guild ID to reconnect
     * @returns {Promise<void>}
     * @throws {Error} If connection fails
     */
    async manualStart(guildId) {
        const connection = this.connections.get(guildId);
        if (!connection) {
            throw new Error(`No connection found for guild: ${guildId}`);
        }

        const guildConfig = connection.getGuildConfig();

        // Allow auto-reconnect again from this point on
        this.manuallyDisconnected.delete(guildId);

        // Cancel any stale timer
        if (this.reconnectTimers.has(guildId)) {
            clearTimeout(this.reconnectTimers.get(guildId));
            this.reconnectTimers.delete(guildId);
        }

        await connection.connect();
        this.setupConnectionMonitoring(guildId);

        this.emit('connection', {
            type: 'manual_reconnect',
            guildId,
            guildName: guildConfig.name,
            username: guildConfig.account.username
        });

        logger.minecraft(`Manual reconnect executed for ${guildConfig.name}`);
    }

    /**
     * Check whether a guild was manually disconnected by a user action.
     *
     * @param {string} guildId - Guild ID to check
     * @returns {boolean}
     */
    isManuallyDisconnected(guildId) {
        return this.manuallyDisconnected.has(guildId);
    }

    /**
     * Stop all guild connections
     *
     * Gracefully shuts down:
     * 1. Clears all reconnection timers
     * 2. Stops inter-guild queue processor
     * 3. Disconnects all bot connections
     * 
     * Uses Promise.allSettled to ensure all disconnections are attempted
     * even if some fail.
     * 
     * @returns {Promise<void>}
     * 
     * @example
     * await botManager.stopAll();
     * console.log('All bots disconnected');
     */
    async stopAll() {
        // Clear all reconnection timers
        for (const timer of this.reconnectTimers.values()) {
            clearTimeout(timer);
        }
        this.reconnectTimers.clear();

        // Stop inter-guild manager
        if (this.interGuildManager) {
            this.interGuildManager.stopQueueProcessor();
        }

        // Disconnect all connections
        const disconnectPromises = [];
        
        for (const [guildId, connection] of this.connections) {
            const promise = connection.disconnect();
            disconnectPromises.push(promise);
        }

        await Promise.allSettled(disconnectPromises);
        logger.minecraft('All connections stopped');
    }

    /**
     * Send message to guild chat
     * 
     * Sends message to specified guild's chat using /gc command.
     * Validates connection exists and is active before sending.
     * Includes detailed logging with [INTER-GUILD] prefix.
     * 
     * @param {string} guildId - Guild ID to send to
     * @param {string} message - Message to send
     * @param {object} [options={}] - Delivery options forwarded to the connection queue
     * @param {string} [options.direction='inter_guild'] - Metrics direction for accounting
     * @returns {Promise<void>} Settles once the message is written to the server
     * @throws {Error} If guild not found, not connected, or send fails
     *
     * @example
     * await botManager.sendMessage('guild1', 'Hello from another guild!');
     */
    async sendMessage(guildId, message, options = {}) {
        const connection = this.connections.get(guildId);
        if (!connection) {
            const error = `No connection found for guild: ${guildId}`;
            logger.error(`[INTER-GUILD] ${error}`);
            throw new Error(error);
        }

        if (!connection.isconnected()) {
            const error = `Guild ${guildId} is not connected`;
            logger.error(`[INTER-GUILD] ${error}`);
            throw new Error(error);
        }

        logger.bridge(`[INTER-GUILD] BotManager queueing guild message for ${guildId}: "${message}"`);

        try {
            const result = await connection.sendMessage(message, options);
            logger.bridge(`[INTER-GUILD] Guild message sent successfully to ${connection.getGuildConfig().name}`);
            return result;
        } catch (error) {
            logger.logError(error, `[INTER-GUILD] Failed to send guild message to ${connection.getGuildConfig().name}`);
            throw error;
        }
    }

    /**
     * Send message to officer chat
     * 
     * Sends message to specified guild's officer chat using /oc command.
     * Validates connection exists and is active before sending.
     * Includes detailed logging with [INTER-GUILD] prefix.
     * 
     * @param {string} guildId - Guild ID to send to
     * @param {string} message - Message to send
     * @param {object} [options={}] - Delivery options forwarded to the connection queue
     * @param {string} [options.direction='inter_guild'] - Metrics direction for accounting
     * @returns {Promise<void>} Settles once the message is written to the server
     * @throws {Error} If guild not found, not connected, or send fails
     *
     * @example
     * await botManager.sendOfficerMessage('guild1', 'Officer announcement');
     */
    async sendOfficerMessage(guildId, message, options = {}) {
        const connection = this.connections.get(guildId);
        if (!connection) {
            const error = `No connection found for guild: ${guildId}`;
            logger.error(`[INTER-GUILD] ${error}`);
            throw new Error(error);
        }

        if (!connection.isconnected()) {
            const error = `Guild ${guildId} is not connected`;
            logger.error(`[INTER-GUILD] ${error}`);
            throw new Error(error);
        }

        logger.bridge(`[INTER-GUILD] BotManager queueing officer message for ${guildId}: "${message}"`);

        try {
            const result = await connection.sendOfficerMessage(message, options);
            logger.bridge(`[INTER-GUILD] Officer message sent successfully to ${connection.getGuildConfig().name}`);
            return result;
        } catch (error) {
            logger.logError(error, `[INTER-GUILD] Failed to send officer message to ${connection.getGuildConfig().name}`);
            throw error;
        }
    }

    /**
     * Execute arbitrary command on guild bot
     * 
     * Sends any command to the specified guild's bot.
     * No validation or formatting applied - command sent as-is.
     * 
     * @param {string} guildId - Guild ID to execute on
     * @param {string} command - Command to execute (including /)
     * @param {object} [options={}] - Delivery options forwarded to the connection queue
     * @param {string} [options.priority='command'] - Queue lane ('command' or 'chat')
     * @param {string} [options.direction='discord_to_mc'] - Metrics direction for accounting
     * @returns {Promise<void>} Settles once the command is written to the server
     * @throws {Error} If guild not found or not connected
     *
     * @example
     * await botManager.executeCommand('guild1', '/g online');
     */
    async executeCommand(guildId, command, options = {}) {
        const connection = this.connections.get(guildId);
        if (!connection) {
            throw new Error(`No connection found for guild: ${guildId}`);
        }

        if (!connection.isconnected()) {
            throw new Error(`Guild ${guildId} is not connected`);
        }

        return connection.executeCommand(command, options);
    }

    /**
     * Get outbound queue statistics for every guild
     *
     * Surfaces per-bot queue depth so a backlog can be spotted before it turns into
     * dropped messages.
     *
     * @returns {object} Queue statistics keyed by guild ID
     *
     * @example
     * const stats = botManager.getQueueStats();
     * Object.values(stats).forEach(s => console.log(`${s.guildName}: ${s.chatDepth}`));
     */
    getQueueStats() {
        const stats = {};

        for (const [guildId, connection] of this.connections) {
            stats[guildId] = connection.getQueueStats();
        }

        return stats;
    }

    /**
     * Get connection status for all guilds
     * 
     * Returns detailed status information for every guild connection
     * including connection state, attempts, timing, and configuration.
     * 
     * @returns {object} Status map keyed by guild ID
     * @returns {boolean} return[guildId].isConnected - Whether connected
     * @returns {boolean} return[guildId].isConnecting - Whether connecting
     * @returns {number} return[guildId].connectionAttempts - Attempt count
     * @returns {number} return[guildId].lastConnectionTime - Last connection timestamp
     * @returns {string} return[guildId].guildName - Guild name
     * @returns {string} return[guildId].username - Bot username
     * @returns {string} return[guildId].server - Server name
     * 
     * @example
     * const status = botManager.getConnectionStatus();
     * for (const [id, info] of Object.entries(status)) {
     *   console.log(`${info.guildName}: ${info.isConnected ? 'Connected' : 'Disconnected'}`);
     * }
     */
    getConnectionStatus() {
        const status = {};
        
        for (const [guildId, connection] of this.connections) {
            status[guildId] = connection.getConnectionStatus();
        }

        return status;
    }

    /**
     * Check if specific guild is connected
     * 
     * @param {string} guildId - Guild ID to check
     * @returns {boolean} Whether guild is connected
     * 
     * @example
     * if (botManager.isGuildConnected('guild1')) {
     *   console.log('Guild is online');
     * }
     */
    isGuildConnected(guildId) {
        const connection = this.connections.get(guildId);
        return connection ? connection.isconnected() : false;
    }

    /**
     * Get list of all connected guilds
     * 
     * Returns array of connected guild information for monitoring
     * and inter-guild coordination.
     * 
     * @returns {Array<object>} Array of connected guild info
     * @returns {string} return[].guildId - Guild ID
     * @returns {string} return[].guildName - Guild name
     * @returns {string} return[].username - Bot username
     * @returns {string} return[].guildTag - Guild tag
     * 
     * @example
     * const connected = botManager.getConnectedGuilds();
     * console.log(`${connected.length} guilds online`);
     * connected.forEach(g => console.log(`- ${g.guildName} [${g.guildTag}]`));
     */
    getConnectedGuilds() {
        const connectedGuilds = [];
        
        for (const [guildId, connection] of this.connections) {
            if (connection.isconnected()) {
                connectedGuilds.push({
                    guildId: guildId,
                    guildName: connection.getGuildConfig().name,
                    username: connection.getGuildConfig().account.username,
                    guildTag: connection.getGuildConfig().tag
                });
            }
        }

        return connectedGuilds;
    }

    /**
     * Update inter-guild configuration
     * 
     * Updates InterGuildManager configuration at runtime without restart.
     * Useful for adjusting rate limits, enabling/disabling features, etc.
     * 
     * @param {object} newConfig - New inter-guild configuration
     * 
     * @example
     * botManager.updateInterGuildConfig({
     *   enabled: true,
     *   rateLimitMs: 1000
     * });
     */
    updateInterGuildConfig(newConfig) {
        if (this.interGuildManager) {
            this.interGuildManager.updateConfig(newConfig);
            logger.info('Inter-guild configuration updated via BotManager');
        }
    }

    /**
     * Clear inter-guild cache
     * 
     * Clears message queue and rate limit cache in InterGuildManager.
     * Useful for troubleshooting or manual intervention.
     */
    clearInterGuildCache() {
        if (this.interGuildManager) {
            this.interGuildManager.clearQueue();
            this.interGuildManager.clearRateLimit();
            logger.info('Inter-guild cache cleared via BotManager');
        }
    }

    /**
     * Register callback for message events
     * 
     * Callback receives parsed message data from guild chat.
     * 
     * @param {function} callback - Callback function (messageData) => void
     * 
     * @example
     * botManager.onMessage((data) => {
     *   console.log(`${data.username}: ${data.message}`);
     * });
     */
    onMessage(callback) {
        this.on('message', callback);
    }

    /**
     * Register callback for event events
     * 
     * Callback receives parsed event data (joins, leaves, promotions, etc.).
     * 
     * @param {function} callback - Callback function (eventData) => void
     * 
     * @example
     * botManager.onEvent((data) => {
     *   console.log(`Event: ${data.type} - ${data.username}`);
     * });
     */
    onEvent(callback) {
        this.on('event', callback);
    }

    /**
     * Register callback for connection events
     * 
     * Callback receives connection state changes (connected, disconnected, reconnected).
     * 
     * @param {function} callback - Callback function (connectionData) => void
     * 
     * @example
     * botManager.onConnection((data) => {
     *   console.log(`${data.guildName}: ${data.type}`);
     * });
     */
    onConnection(callback) {
        this.on('connection', callback);
    }

    /**
     * Register callback for error events
     * 
     * Callback receives error objects from connection and processing failures.
     * 
     * @param {function} callback - Callback function (error, guildId) => void
     * 
     * @example
     * botManager.onError((error, guildId) => {
     *   console.error(`Error in guild ${guildId}:`, error);
     * });
     */
    onError(callback) {
        this.on('error', callback);
    }
}

module.exports = BotManager;