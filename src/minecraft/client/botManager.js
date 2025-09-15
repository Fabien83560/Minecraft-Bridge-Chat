// Globals Imports
const EventEmitter = require('events');

// Specific Imports
const BridgeLocator = require("../../bridgeLocator.js");
const MinecraftConnection = require("./connection.js");
const MessageCoordinator = require("../parsers/MessageCoordinator.js");
const logger = require("../../shared/logger");

class BotManager extends EventEmitter {
    constructor() {
        super();

        const mainBridge = BridgeLocator.getInstance();
        this.config = mainBridge.config;

        this.connections = new Map();
        this.reconnectTimers = new Map();
        this.messageCoordinator = new MessageCoordinator();

        this.initialize();
    }

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
        })
    }

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
        })

        logger.minecraft(`✅ Connection summary: ${successCount} successful, ${failCount} failed`);
        
        if (successCount === 0) {
            throw new Error('Failed to start any Minecraft connections');
        }
    }

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

    scheduleReconnection(guildId) {
        const connection = this.connections.get(guildId);
        if (!connection)
            return;

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

    async stopAll() {
        // Clear all reconnection timers
        for (const timer of this.reconnectTimers.values()) {
            clearTimeout(timer);
        }
        this.reconnectTimers.clear();

        // Disconnect all connections
        const disconnectPromises = [];
        
        for (const [guildId, connection] of this.connections) {
            const promise = connection.disconnect();
            disconnectPromises.push(promise);
        }

        await Promise.allSettled(disconnectPromises);
        logger.minecraft('All connections stopped');
    }

    // Public methods for message sending
    async sendMessage(guildId, message) {
        const connection = this.connections.get(guildId);
        if (!connection) {
            throw new Error(`No connection found for guild: ${guildId}`);
        }

        if (!connection.isconnected()) {
            throw new Error(`Guild ${guildId} is not connected`);
        }

        return connection.sendMessage(message);
    }

    async executeCommand(guildId, command) {
        const connection = this.connections.get(guildId);
        if (!connection) {
            throw new Error(`No connection found for guild: ${guildId}`);
        }

        if (!connection.isconnected()) {
            throw new Error(`Guild ${guildId} is not connected`);
        }

        return connection.executeCommand(command);
    }

    // Status methods
    getConnectionStatus() {
        const status = {};
        
        for (const [guildId, connection] of this.connections) {
            status[guildId] = connection.getConnectionStatus();
        }

        return status;
    }

    isGuildConnected(guildId) {
        const connection = this.connections.get(guildId);
        return connection ? connection.isconnected() : false;
    }

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

    // Event forwarding methods
    onMessage(callback) {
        this.on('message', callback);
    }

    onEvent(callback) {
        this.on('event', callback);
    }

    onConnection(callback) {
        this.on('connection', callback);
    }

    onError(callback) {
        this.on('error', callback);
    }
}

module.exports = BotManager;