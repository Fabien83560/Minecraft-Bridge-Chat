// Globals Imports
const EventEmitter = require('events');

// Specific Imports
const BridgeLocator = require("../../bridgeLocator.js");
const Connection = require("./connection.js");
const MessageCoordinator = require("./parsers/MessageCoordinator.js");
const InterGuildManager = require("../../shared/InterGuildManager.js");
const logger = require("../../shared/logger");

class BotManager extends EventEmitter {
    constructor() {
        super();

        const mainBridge = BridgeLocator.getInstance();
        this.config = mainBridge.config;

        this.connections = new Map();
        this.reconnectTimers = new Map();
        this.messageCoordinator = new MessageCoordinator();
        this.interGuildManager = new InterGuildManager();

        // Load all guild configurations
        this.guilds = this.config.get('guilds');

        logger.debug('BotManager initialized');
    }

    // ==================== LIFECYCLE METHODS ====================

    /**
     * Start all bot connections
     */
    async startAll() {
        try {
            logger.minecraft('Starting all bot connections...');

            // Filter enabled guilds
            const enabledGuilds = this.guilds.filter(guild => guild.enabled);
            
            if (enabledGuilds.length === 0) {
                logger.warn('No enabled guilds found');
                return;
            }

            logger.minecraft(`Found ${enabledGuilds.length} enabled guild(s)`);

            // Start connections for all enabled guilds
            const startPromises = enabledGuilds.map(guild => this.startConnection(guild));
            await Promise.allSettled(startPromises);

            logger.minecraft('✅ All bot connections started');

        } catch (error) {
            logger.logError(error, 'Failed to start all bot connections');
            throw error;
        }
    }

    /**
     * Stop all bot connections
     */
    async stopAll() {
        try {
            logger.minecraft('Stopping all bot connections...');

            // Clear all reconnect timers
            for (const timer of this.reconnectTimers.values()) {
                clearTimeout(timer);
            }
            this.reconnectTimers.clear();

            // Stop all connections
            const stopPromises = Array.from(this.connections.values()).map(connection =>
                connection.disconnect(true)
            );

            await Promise.allSettled(stopPromises);
            this.connections.clear();

            logger.minecraft('✅ All bot connections stopped');

        } catch (error) {
            logger.logError(error, 'Error stopping bot connections');
        }
    }

    /**
     * Start connection for a specific guild
     * @param {object} guildConfig - Guild configuration
     */
    async startConnection(guildConfig) {
        try {
            logger.minecraft(`Starting connection for guild: ${guildConfig.name} (${guildConfig.account.username})`);

            const connection = new Connection();
            this.connections.set(guildConfig.id, connection);

            // Setup connection event handlers
            this.setupConnectionHandlers(connection, guildConfig);

            // Connect to the guild
            await connection.connect(guildConfig);

            logger.minecraft(`✅ Connected to guild: ${guildConfig.name}`);

            // Emit connection event
            this.emit('connection', {
                type: 'connect',
                guildId: guildConfig.id,
                guildName: guildConfig.name,
                username: guildConfig.account.username,
                timestamp: Date.now()
            });

        } catch (error) {
            logger.logError(error, `Failed to connect to guild: ${guildConfig.name}`);

            // Emit error event
            this.emit('error', error, guildConfig.id);

            // Schedule reconnection if enabled
            this.scheduleReconnection(guildConfig.id);
        }
    }

    /**
     * Setup event handlers for a connection
     * @param {Connection} connection - Connection instance
     * @param {object} guildConfig - Guild configuration
     */
    setupConnectionHandlers(connection, guildConfig) {
        // Message handler
        connection.setMessageCallback((rawMessage, guildMessageData) => {
            this.handleGuildMessage(guildConfig.id, rawMessage, guildMessageData);
        });

        // Event handler
        connection.setEventCallback((eventData) => {
            this.handleGuildEvent(guildConfig.id, eventData);
        });

        // Disconnection handler
        connection.on('disconnect', (reason) => {
            logger.minecraft(`Guild ${guildConfig.name} disconnected: ${reason}`);
            
            // Emit disconnection event
            this.emit('connection', {
                type: 'disconnect',
                guildId: guildConfig.id,
                guildName: guildConfig.name,
                username: guildConfig.account.username,
                reason: reason,
                timestamp: Date.now()
            });

            // Schedule reconnection
            this.scheduleReconnection(guildConfig.id);
        });

        // Error handler
        connection.on('error', (error) => {
            logger.logError(error, `Connection error for guild ${guildConfig.name}`);
            
            // Emit error event
            this.emit('error', error, guildConfig.id);
        });
    }

    /**
     * Handle guild messages that have been filtered by the strategy
     * @param {string} guildId - Guild ID
     * @param {object} rawMessage - Raw message from Minecraft
     * @param {object} guildMessageData - Processed guild message data from strategy
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
     * Handle guild events
     * @param {string} guildId - Guild ID
     * @param {object} eventData - Event data
     */
    handleGuildEvent(guildId, eventData) {
        const connection = this.connections.get(guildId);
        if (!connection) {
            logger.warn(`Received event for unknown guild: ${guildId}`);
            return;
        }

        const guildConfig = connection.getGuildConfig();
        
        try {
            // Add guild information to event data
            eventData.guildId = guildId;
            eventData.guildName = guildConfig.name;

            logger.bridge(`[GUILD] [${guildConfig.name}] Emitting event - Type: ${eventData.type}, Username: ${eventData.username || 'system'}`);
            this.emit('event', eventData);
            
        } catch (error) {
            logger.logError(error, `Error processing guild event for ${guildConfig.name}`);
        }
    }

    /**
     * Handle inter-guild processing for messages and events
     * @param {object} result - Processed message/event result
     * @param {object} guildConfig - Guild configuration
     * @param {object} guildMessageData - Strategy message data
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
                
            } else if (result.category === 'message' && result.data.type === 'officer_chat') {
                // Process officer chat message for inter-guild transfer
                await this.interGuildManager.processOfficerMessage(result.data, guildConfig, this);
                
            } else if (result.category === 'event' && result.data.parsedSuccessfully) {
                // Process guild event for inter-guild transfer
                await this.interGuildManager.processGuildEvent(result.data, guildConfig, this);
            }
            
        } catch (error) {
            logger.logError(error, `Error in inter-guild processing for ${guildConfig.name}`);
        }
    }

    /**
     * Schedule reconnection for a guild
     * @param {string} guildId - Guild ID
     */
    scheduleReconnection(guildId) {
        const connection = this.connections.get(guildId);
        if (!connection) return;

        const guildConfig = connection.getGuildConfig();
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
                this.reconnectTimers.delete(guildId);
                await this.startConnection(guildConfig);
            } catch (error) {
                logger.logError(error, `Reconnection failed for ${guildConfig.name}`);
            }
        }, delay);

        this.reconnectTimers.set(guildId, timer);
    }

    // ==================== MESSAGE SENDING METHODS ====================

    /**
     * Send message to guild chat
     * @param {string} guildId - Guild ID
     * @param {string} message - Message to send
     * @returns {Promise} Send promise
     */
    async sendMessage(guildId, message) {
        const connection = this.connections.get(guildId);
        if (!connection) {
            throw new Error(`No connection found for guild: ${guildId}`);
        }

        try {
            await connection.sendMessage(message);
            logger.debug(`[BOT] Guild message sent to ${guildId}: "${message}"`);
        } catch (error) {
            logger.logError(error, `Failed to send guild message to ${guildId}`);
            throw error;
        }
    }

    /**
     * Send message to officer chat (NEW - for bidirectional bridge)
     * @param {string} guildId - Guild ID
     * @param {string} message - Message to send
     * @returns {Promise} Send promise
     */
    async sendOfficerMessage(guildId, message) {
        const connection = this.connections.get(guildId);
        if (!connection) {
            throw new Error(`No connection found for guild: ${guildId}`);
        }

        try {
            // Check if connection has sendOfficerMessage method
            if (typeof connection.sendOfficerMessage === 'function') {
                await connection.sendOfficerMessage(message);
            } else {
                // Fallback: use executeCommand
                await connection.executeCommand(`/oc ${message}`);
            }
            logger.debug(`[BOT] Officer message sent to ${guildId}: "${message}"`);
        } catch (error) {
            logger.logError(error, `Failed to send officer message to ${guildId}`);
            throw error;
        }
    }

    /**
     * Execute command on a guild bot
     * @param {string} guildId - Guild ID
     * @param {string} command - Command to execute
     * @returns {Promise} Execute promise
     */
    async executeCommand(guildId, command) {
        const connection = this.connections.get(guildId);
        if (!connection) {
            throw new Error(`No connection found for guild: ${guildId}`);
        }

        try {
            await connection.executeCommand(command);
            logger.debug(`[BOT] Command executed on ${guildId}: "${command}"`);
        } catch (error) {
            logger.logError(error, `Failed to execute command on ${guildId}`);
            throw error;
        }
    }

    // ==================== STATUS AND INFORMATION METHODS ====================

    /**
     * Get connection status for all guilds
     * @returns {object} Connection status object
     */
    getConnectionStatus() {
        const status = {};
        
        for (const [guildId, connection] of this.connections.entries()) {
            status[guildId] = {
                connected: connection.isConnected(),
                lastSeen: connection.getLastSeen ? connection.getLastSeen() : Date.now(),
                errors: connection.getErrorCount ? connection.getErrorCount() : 0,
                messages: connection.getMessageCount ? connection.getMessageCount() : 0
            };
        }

        return status;
    }

    /**
     * Check if a specific guild is connected
     * @param {string} guildId - Guild ID
     * @returns {boolean} Connection status
     */
    isGuildConnected(guildId) {
        const connection = this.connections.get(guildId);
        return connection ? connection.isConnected() : false;
    }

    /**
     * Get list of connected guilds (using existing structure)
     * @returns {Array} Array of connected guild objects
     */
    getConnectedGuilds() {
        const connectedGuilds = [];
        
        for (const [guildId, connection] of this.connections.entries()) {
            if (connection.isConnected()) {
                const guildConfig = connection.getGuildConfig();
                connectedGuilds.push({
                    guildId: guildId,
                    guildName: guildConfig.name,
                    username: guildConfig.account.username,
                    guildTag: guildConfig.tag || guildConfig.name
                });
            }
        }

        return connectedGuilds;
    }

    // ==================== INTER-GUILD MANAGER METHODS ====================

    /**
     * Get inter-guild statistics
     * @returns {object} Inter-guild statistics
     */
    getInterGuildStats() {
        if (!this.interGuildManager) {
            return null;
        }

        return this.interGuildManager.getStatistics();
    }

    /**
     * Update inter-guild configuration
     * @param {object} newConfig - New configuration
     */
    updateInterGuildConfig(newConfig) {
        if (this.interGuildManager) {
            this.interGuildManager.updateConfig(newConfig);
            logger.info('Inter-guild configuration updated via BotManager');
        }
    }

    /**
     * Test inter-guild message formatting
     * @param {object} testData - Test data
     * @returns {object} Test result
     */
    testInterGuildFormatting(testData) {
        if (!this.interGuildManager) {
            return { error: 'InterGuildManager not available' };
        }

        return this.interGuildManager.testMessageFormatting(testData);
    }

    /**
     * Clear inter-guild cache
     */
    clearInterGuildCache() {
        if (this.interGuildManager) {
            this.interGuildManager.clearQueue();
            this.interGuildManager.clearRateLimit();
            logger.info('Inter-guild cache cleared via BotManager');
        }
    }

    // ==================== EVENT FORWARDING METHODS ====================

    /**
     * Register message event handler
     * @param {function} callback - Callback function
     */
    onMessage(callback) {
        this.on('message', callback);
    }

    /**
     * Register event handler
     * @param {function} callback - Callback function
     */
    onEvent(callback) {
        this.on('event', callback);
    }

    /**
     * Register connection event handler
     * @param {function} callback - Callback function
     */
    onConnection(callback) {
        this.on('connection', callback);
    }

    /**
     * Register error event handler
     * @param {function} callback - Callback function
     */
    onError(callback) {
        this.on('error', callback);
    }

    // ==================== DEBUGGING AND UTILITIES ====================

    /**
     * Get BotManager statistics
     * @returns {object} Statistics object
     */
    getStatistics() {
        return {
            totalConnections: this.connections.size,
            connectedGuilds: this.getConnectedGuilds().length,
            reconnectTimers: this.reconnectTimers.size,
            interGuildStats: this.getInterGuildStats()
        };
    }

    /**
     * Get debugging information
     * @returns {object} Debug information
     */
    getDebugInfo() {
        const connectionDetails = {};
        
        for (const [guildId, connection] of this.connections.entries()) {
            const guildConfig = connection.getGuildConfig();
            connectionDetails[guildId] = {
                name: guildConfig.name,
                tag: guildConfig.tag,
                username: guildConfig.account.username,
                connected: connection.isConnected(),
                lastSeen: connection.getLastSeen ? connection.getLastSeen() : null,
                hasReconnectTimer: this.reconnectTimers.has(guildId)
            };
        }

        return {
            connections: this.connections.size,
            reconnectTimers: this.reconnectTimers.size,
            stats: this.getStatistics(),
            connectionDetails,
            interGuildStats: this.getInterGuildStats()
        };
    }

    /**
     * Test message sending capabilities
     * @param {string} guildId - Guild ID to test
     * @param {object} testOptions - Test options
     * @returns {object} Test result
     */
    async testMessageSending(guildId, testOptions = {}) {
        try {
            const connection = this.connections.get(guildId);
            if (!connection) {
                return { success: false, error: `No connection found for guild: ${guildId}` };
            }

            if (!connection.isConnected()) {
                return { success: false, error: `Guild ${guildId} is not connected` };
            }

            const testMessage = testOptions.message || 'Bridge test message';
            const testType = testOptions.type || 'guild'; // 'guild' or 'officer'

            const results = [];

            // Test guild message
            if (testType === 'guild' || testType === 'both') {
                try {
                    await this.sendMessage(guildId, `[TEST] ${testMessage}`);
                    results.push({ type: 'guild', success: true });
                } catch (error) {
                    results.push({ type: 'guild', success: false, error: error.message });
                }
            }

            // Test officer message
            if (testType === 'officer' || testType === 'both') {
                try {
                    await this.sendOfficerMessage(guildId, `[TEST] ${testMessage}`);
                    results.push({ type: 'officer', success: true });
                } catch (error) {
                    results.push({ type: 'officer', success: false, error: error.message });
                }
            }

            return {
                success: true,
                guildId,
                testMessage,
                results
            };

        } catch (error) {
            logger.logError(error, `Error testing message sending for guild ${guildId}`);
            return { success: false, error: error.message };
        }
    }

    /**
     * Cleanup resources
     */
    cleanup() {
        // Clear reconnect timers
        for (const timer of this.reconnectTimers.values()) {
            clearTimeout(timer);
        }
        this.reconnectTimers.clear();

        // Cleanup connections
        for (const connection of this.connections.values()) {
            connection.removeAllListeners();
        }
        this.connections.clear();

        // Cleanup inter-guild manager
        if (this.interGuildManager) {
            this.interGuildManager.cleanup();
        }

        logger.debug('BotManager cleaned up');
    }
}

module.exports = BotManager;