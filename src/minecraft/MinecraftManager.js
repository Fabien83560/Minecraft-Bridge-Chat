/**
 * Minecraft Manager - Core Minecraft Bot Connection and Event Management System
 * 
 * This class serves as the primary interface for managing Minecraft bot connections,
 * handling guild communications, and coordinating events between Minecraft and Discord.
 * It manages the lifecycle of bot instances, forwards events to registered handlers,
 * and provides a unified API for Minecraft operations.
 * 
 * The manager provides:
 * - Lifecycle management (initialize, start, stop)
 * - Multi-guild bot connection management via BotManager
 * - Event forwarding system with handler registration
 * - Discord integration coordination via BridgeCoordinator
 * - Message and command execution to guild chats
 * - Connection status tracking and monitoring
 * - Inter-guild configuration management
 * - Error handling and recovery
 * 
 * Event types handled:
 * - Messages: Guild and officer chat messages
 * - Events: Join, leave, promote, demote, level, etc.
 * - Connections: Connect, disconnect, reconnect events
 * - Errors: Bot errors and connection failures
 * 
 * Integration architecture:
 * 1. MinecraftManager initializes BotManager for bot connections
 * 2. Event forwarding setup captures all bot events
 * 3. Discord integration setup creates BridgeCoordinator
 * 4. External handlers register for specific event types
 * 5. Events flow: Bot → BotManager → MinecraftManager → Handlers
 * 
 * Lifecycle states:
 * - Uninitialized: Constructor called, no setup done
 * - Initialized: BotManager created, ready to start
 * - Started: All bots connected, events forwarding
 * - Stopped: All bots disconnected, cleanup done
 * 
 * @author Fabien83560
 * @version 1.0.0
 * @license ISC
 */

// Globals Imports
const fs = require('fs');

// Specific Imports
const BridgeCoordinator = require('../discord/bridge/BridgeCoordinator.js');
const BotManager = require("./client/BotManager.js")
const BridgeLocator = require("../bridgeLocator.js");
const logger = require('../shared/logger/index.js');

/**
 * MinecraftManager - Manage Minecraft bot connections and events
 * 
 * Main manager class that coordinates all Minecraft bot operations, event handling,
 * and Discord integration. Implements lifecycle management and provides public API
 * for Minecraft interactions.
 * 
 * @class
 */
class MinecraftManager {
    /**
     * Create a new MinecraftManager instance
     * 
     * Initializes the manager with configuration from BridgeLocator and sets up
     * internal state. Creates event handler arrays for message, event, connection,
     * and error callbacks. Automatically calls initialize() to set up BotManager.
     * 
     * Initial state:
     * - _isInitialized: false
     * - _isStarted: false
     * - _botManager: null
     * - _discordManager: null
     * - _bridgeCoordinator: null
     * - All handler arrays: empty
     * 
     * @example
     * const minecraftManager = new MinecraftManager();
     * // Automatically initialized, ready to start
     */
    constructor() {
        const mainBridge = BridgeLocator.getInstance();
        this.config = mainBridge.config;

        this._isInitialized = false;
        this._isStarted = false;
        this._botManager = null;
        
        // Discord integration
        this._discordManager = null;
        this._bridgeCoordinator = null;

        // Event handlers
        this.messageHandlers = [];
        this.eventHandlers = [];
        this.connectionHandlers = [];
        this.errorHandlers = [];

        this.initialize();
    }

    /**
     * Initialize Minecraft manager
     * 
     * Sets up the BotManager instance which handles individual bot connections.
     * This method is called automatically during construction and should only be
     * called once. Prevents re-initialization with guard check.
     * 
     * Initialization steps:
     * 1. Check if already initialized
     * 2. Create BotManager instance
     * 3. Set initialization flag
     * 
     * @async
     * @throws {Error} If BotManager creation fails
     * 
     * @example
     * // Called automatically in constructor
     * await manager.initialize();
     */
    async initialize() {
        if(this._isInitialized) {
            logger.warn("MinecraftManager already initialized");
            return;
        }

        try {
            logger.minecraft("Initializing Minecraft module...");

            this._botManager = new BotManager();

            this._isInitialized = true;
            logger.minecraft("✅ Minecraft module initialized")
        } catch (error) {
            logger.logError(error, 'Failed to initialize Minecraft module');
            throw error;
        }
    }

    /**
     * Start all Minecraft connections
     * 
     * Initiates connections for all configured guilds by starting the BotManager.
     * Sets up event forwarding system to capture and route bot events to registered
     * handlers. Must be called after initialization and before any operations.
     * 
     * Start sequence:
     * 1. Validate manager is initialized
     * 2. Check not already started
     * 3. Start all bot connections via BotManager
     * 4. Setup event forwarding system
     * 5. Set started flag
     * 
     * Note: Discord integration is setup separately via setDiscordManager()
     * called from main.js during cross-manager integration phase.
     * 
     * @async
     * @throws {Error} If not initialized or if starting connections fails
     * 
     * @example
     * const manager = new MinecraftManager();
     * await manager.start();
     * // All bots now connected and events forwarding
     * 
     * @example
     * try {
     *   await manager.start();
     *   console.log('All Minecraft bots started');
     * } catch (error) {
     *   console.error('Failed to start:', error);
     * }
     */
    async start() {
        if(!this._isInitialized)  {
            throw new Error('MinecraftManager must be initialized before starting');
        }

        if (this._isStarted) {
            logger.warn('MinecraftManager already started');
            return;
        }

        try {
            logger.minecraft('Starting Minecraft connections...');
            
            // Start all bot connections
            await this._botManager.startAll();
            
            // Setup event forwarding first
            this.setupEventForwarding();
            
            // NOTE: Discord integration will be setup later via setDiscordManager()
            // called from main.js setupCrossManagerIntegration()
            
            this._isStarted = true;
            logger.minecraft('✅ All Minecraft connections started successfully');
            
        } catch (error) {
            logger.logError(error, 'Failed to start Minecraft connections');
            throw error;
        }
    }

    /**
     * Stop all Minecraft connections
     * 
     * Gracefully shuts down all bot connections and cleans up resources.
     * Stops BotManager, cleans up BridgeCoordinator, and resets started flag.
     * Safe to call even if not started.
     * 
     * Stop sequence:
     * 1. Check if started
     * 2. Stop all bots via BotManager
     * 3. Cleanup BridgeCoordinator
     * 4. Reset started flag
     * 
     * @async
     * @throws {Error} If stopping connections fails
     * 
     * @example
     * await manager.stop();
     * // All bots disconnected, resources cleaned up
     * 
     * @example
     * // Graceful shutdown
     * process.on('SIGINT', async () => {
     *   await manager.stop();
     *   process.exit(0);
     * });
     */
    async stop() {
        if (!this._isStarted) {
            logger.debug('MinecraftManager not started, nothing to stop');
            return;
        }

        try {
            logger.minecraft('Stopping Minecraft connections...');
            
            if (this._botManager) {
                await this._botManager.stopAll();
            }
            
            // Cleanup bridge coordinator
            if (this._bridgeCoordinator) {
                this._bridgeCoordinator.cleanup();
                this._bridgeCoordinator = null;
            }
            
            this._isStarted = false;
            logger.minecraft('✅ All Minecraft connections stopped');
        
        } catch (error) {
            logger.logError(error, 'Error stopping Minecraft connections');
            throw error;
        }
    }

    /**
     * Setup event forwarding from BotManager
     * 
     * Establishes event forwarding pipeline by registering callbacks with BotManager.
     * Captures all bot events (messages, events, connections, errors) and forwards
     * them to registered external handlers. Includes error handling for each handler
     * to prevent one failing handler from breaking the chain.
     * 
     * Event flow:
     * 1. Bot generates event
     * 2. BotManager captures event
     * 3. MinecraftManager forwards to all registered handlers
     * 4. Each handler processes event independently
     * 
     * Forwarded event types:
     * - onMessage: Guild and officer chat messages
     * - onEvent: Guild events (join, leave, promote, etc.)
     * - onConnection: Connection status changes
     * - onError: Bot errors and failures
     * 
     * @private
     * 
     * @example
     * // Internal usage during start()
     * this.setupEventForwarding();
     */
    setupEventForwarding() {
        // Forward bot manager events to external handlers
        this._botManager.onMessage((data) => {
            logger.debug(`[MINECRAFT] Message event forwarded: ${data.username} -> "${data.message}"`);
            
            this.messageHandlers.forEach(handler => {
                try {
                    handler(data);
                } catch (error) {
                    logger.logError(error, 'Error in message handler');
                }
            });
        });

        this._botManager.onEvent((data) => {
            logger.debug(`[MINECRAFT] Event forwarded: ${data.type} for ${data.username || 'system'}`);
            
            this.eventHandlers.forEach(handler => {
                try {
                    handler(data);
                } catch (error) {
                    logger.logError(error, 'Error in event handler');
                }
            });
        });

        this._botManager.onConnection((data) => {
            this.connectionHandlers.forEach(handler => {
                try {
                    handler(data);
                } catch (error) {
                    logger.logError(error, 'Error in connection handler');
                }
            });
        });

        this._botManager.onError((error, guildId) => {
            this.errorHandlers.forEach(handler => {
                try {
                    handler(error, guildId);
                } catch (handlerError) {
                    logger.logError(handlerError, 'Error in error handler');
                }
            });
        });
    }

    /**
     * Setup Discord integration (legacy method)
     * 
     * Attempts to setup Discord integration by retrieving Discord manager from
     * BridgeLocator. Kept for backward compatibility but now primarily relies on
     * setDiscordManager() being called from main.js during startup.
     * 
     * If Discord manager is not available yet, logs debug message and integration
     * will be setup later when setDiscordManager() is called.
     * 
     * @deprecated Prefer using setDiscordManager() for explicit integration setup
     * 
     * @example
     * // Internal usage - called during startup
     * this.setupDiscordIntegration();
     */
    setupDiscordIntegration() {
        try {
            logger.debug('[INTEGRATION] Starting Discord integration setup...');
            
            const mainBridge = BridgeLocator.getInstance();
            logger.debug('[INTEGRATION] Got main bridge instance');
            
            const discordManager = mainBridge.getDiscordManager?.();
            logger.debug(`[INTEGRATION] Discord manager: ${discordManager ? 'Available' : 'Not available'}`);

            if (discordManager) {
                this.setupDiscordIntegrationInternal(discordManager);
            } else {
                logger.debug('[INTEGRATION] Discord manager not available yet, will be set later via setDiscordManager()');
            }
            
        } catch (error) {
            logger.logError(error, 'Failed to setup Discord integration for MinecraftManager');
        }
    }

    /**
     * Set Discord manager reference
     * 
     * Called from main bridge during cross-manager integration to establish Discord
     * connection. Creates BridgeCoordinator if manager is started and Discord manager
     * is provided. This is the preferred method for setting up Discord integration.
     * 
     * Conditions for automatic integration setup:
     * - Manager must be started (_isStarted = true)
     * - Discord manager must be provided (not null)
     * - BridgeCoordinator must not already exist
     * 
     * @param {object} discordManager - Discord manager instance
     * 
     * @example
     * // Called from main.js
     * minecraftManager.setDiscordManager(discordManager);
     * 
     * @example
     * // Manual integration setup
     * if (discordReady) {
     *   minecraftManager.setDiscordManager(getDiscordManager());
     * }
     */
    setDiscordManager(discordManager) {
        logger.debug(`[INTEGRATION] setDiscordManager called with: ${discordManager ? 'valid manager' : 'null'}`);
        
        this._discordManager = discordManager;
        
        if (this._isStarted && discordManager && !this._bridgeCoordinator) {
            logger.debug('[INTEGRATION] Setting up Discord integration via setDiscordManager...');
            this.setupDiscordIntegrationInternal(discordManager);
        } else {
            logger.debug(`[INTEGRATION] Integration conditions not met: started=${this._isStarted}, manager=${!!discordManager}, coordinator=${!!this._bridgeCoordinator}`);
        }
    }

    /**
     * Internal Discord integration setup
     * 
     * Creates BridgeCoordinator instance and initializes it with Discord and Minecraft
     * managers. This establishes the bidirectional communication bridge between platforms.
     * Should only be called when Discord manager is available and valid.
     * 
     * Setup steps:
     * 1. Validate Discord manager provided
     * 2. Create BridgeCoordinator instance
     * 3. Initialize coordinator with both managers
     * 4. Log successful integration
     * 
     * @private
     * @param {object} discordManager - Discord manager instance to integrate with
     * 
     * @example
     * // Internal usage from setDiscordManager
     * this.setupDiscordIntegrationInternal(discordManager);
     */
    setupDiscordIntegrationInternal(discordManager) {
        try {
            logger.debug('[INTEGRATION] Starting internal Discord integration setup...');
            
            if (!discordManager) {
                logger.warn('[INTEGRATION] No Discord manager provided');
                return;
            }

            this._bridgeCoordinator = new BridgeCoordinator();
            logger.debug('[INTEGRATION] BridgeCoordinator created, initializing...');
            
            this._bridgeCoordinator.initialize(discordManager, this);
            logger.bridge('✅ Discord integration setup completed for MinecraftManager');

        } catch (error) {
            logger.logError(error, 'Failed to setup internal Discord integration');
        }
    }

    // ==================== Event Registration Methods ====================
    
    /**
     * Register message event handler
     * 
     * Registers a callback to receive all message events from Minecraft guilds.
     * Handler will be called for both guild chat and officer chat messages.
     * Multiple handlers can be registered and all will be called for each message.
     * 
     * @param {Function} callback - Callback function to handle message events
     * @param {object} callback.messageData - Message data object
     * @param {string} callback.messageData.guildId - Guild ID
     * @param {string} callback.messageData.username - Sender username
     * @param {string} callback.messageData.message - Message content
     * @param {string} callback.messageData.chatType - Chat type ('guild' or 'officer')
     * 
     * @example
     * manager.onMessage((data) => {
     *   console.log(`${data.username}: ${data.message}`);
     * });
     * 
     * @example
     * // Log all guild messages
     * manager.onMessage((data) => {
     *   if (data.chatType === 'guild') {
     *     logger.info(`Guild message from ${data.username}`);
     *   }
     * });
     */
    onMessage(callback) {
        this.messageHandlers.push(callback);
        logger.debug(`[EVENT] Message handler registered (total: ${this.messageHandlers.length})`);
    }

    /**
     * Register event handler
     * 
     * Registers a callback to receive all guild events from Minecraft.
     * Handler will be called for join, leave, promote, demote, level, and other events.
     * Multiple handlers can be registered.
     * 
     * @param {Function} callback - Callback function to handle events
     * @param {object} callback.eventData - Event data object
     * @param {string} callback.eventData.guildId - Guild ID
     * @param {string} callback.eventData.type - Event type
     * @param {string} [callback.eventData.username] - Username involved (if applicable)
     * 
     * @example
     * manager.onEvent((data) => {
     *   console.log(`Event: ${data.type} for ${data.username}`);
     * });
     * 
     * @example
     * // Track promotions
     * manager.onEvent((data) => {
     *   if (data.type === 'promote') {
     *     logger.info(`${data.username} promoted to ${data.toRank}`);
     *   }
     * });
     */
    onEvent(callback) {
        this.eventHandlers.push(callback);
        logger.debug(`[EVENT] Event handler registered (total: ${this.eventHandlers.length})`);
    }

    /**
     * Register connection event handler
     * 
     * Registers a callback to receive bot connection status changes.
     * Handler will be called for connect, disconnect, and reconnect events.
     * Useful for monitoring bot connection health.
     * 
     * @param {Function} callback - Callback function to handle connection events
     * @param {object} callback.connectionData - Connection data object
     * @param {string} callback.connectionData.guildId - Guild ID
     * @param {string} callback.connectionData.type - Connection type ('connected', 'disconnected', 'reconnected')
     * 
     * @example
     * manager.onConnection((data) => {
     *   console.log(`Guild ${data.guildId}: ${data.type}`);
     * });
     * 
     * @example
     * // Alert on disconnections
     * manager.onConnection((data) => {
     *   if (data.type === 'disconnected') {
     *     alertAdmin(`Bot disconnected from ${data.guildId}`);
     *   }
     * });
     */
    onConnection(callback) {
        this.connectionHandlers.push(callback);
        logger.debug(`[EVENT] Connection handler registered (total: ${this.connectionHandlers.length})`);
    }

    /**
     * Register error handler
     * 
     * Registers a callback to receive bot error events.
     * Handler will be called for all bot errors and connection failures.
     * Useful for centralized error tracking and recovery.
     * 
     * @param {Function} callback - Callback function to handle errors
     * @param {Error} callback.error - Error object
     * @param {string} callback.guildId - Guild ID where error occurred
     * 
     * @example
     * manager.onError((error, guildId) => {
     *   logger.error(`Error in ${guildId}:`, error);
     * });
     * 
     * @example
     * // Track error statistics
     * manager.onError((error, guildId) => {
     *   errorTracker.record(guildId, error.message);
     * });
     */
    onError(callback) {
        this.errorHandlers.push(callback);
        logger.debug(`[EVENT] Error handler registered (total: ${this.errorHandlers.length})`);
    }

    // ==================== Public Message/Command Methods ====================
    
    /**
     * Send message to guild chat
     * 
     * Sends a message to the specified guild's chat using the /gc command.
     * Requires manager to be started. Messages are queued by BotManager for
     * reliable delivery.
     * 
     * @async
     * @param {string} guildId - Guild ID to send message to
     * @param {string} message - Message content to send
     * @returns {Promise<void>} Resolves when message is queued
     * @throws {Error} If manager not started or if sending fails
     * 
     * @example
     * await manager.sendMessage('guild123', 'Hello from bot!');
     * 
     * @example
     * // Send formatted message
     * const msg = `[Announcement] Server restart in 5 minutes`;
     * await manager.sendMessage(guildId, msg);
     */
    async sendMessage(guildId, message, options = {}) {
        if (!this._isStarted || !this._botManager) {
            throw new Error('MinecraftManager not started');
        }

        return this._botManager.sendMessage(guildId, message, options);
    }

    /**
     * Send message to a guild's officer chat
     *
     * Queues an /oc write for the specified guild through that bot's serialized
     * outbound queue.
     *
     * @async
     * @param {string} guildId - Guild ID to send to
     * @param {string} message - Message to send
     * @param {object} [options={}] - Delivery options forwarded to the connection queue
     * @param {string} [options.direction='inter_guild'] - Metrics direction for accounting
     * @returns {Promise<void>} Settles once the message is written to the server
     * @throws {Error} If manager not started, guild not found, or not connected
     *
     * @example
     * await manager.sendOfficerMessage('guild123', 'Officer only announcement');
     */
    async sendOfficerMessage(guildId, message, options = {}) {
        if (!this._isStarted || !this._botManager) {
            throw new Error('MinecraftManager not started');
        }

        return this._botManager.sendOfficerMessage(guildId, message, options);
    }

    /**
     * Get outbound queue statistics for every guild
     *
     * @returns {object} Queue statistics keyed by guild ID, empty if not started
     *
     * @example
     * const stats = manager.getQueueStats();
     */
    getQueueStats() {
        if (!this._botManager) {
            return {};
        }

        return this._botManager.getQueueStats();
    }

    /**
     * Execute command in guild
     * 
     * Executes a Minecraft command for the specified guild. Can be any command
     * the bot has permission to use (/g promote, /g kick, etc.). Requires manager
     * to be started.
     * 
     * @async
     * @param {string} guildId - Guild ID to execute command in
     * @param {string} command - Command to execute (with /)
     * @returns {Promise<void>} Resolves when command is executed
     * @throws {Error} If manager not started or if execution fails
     * 
     * @example
     * await manager.executeCommand('guild123', '/g promote Player123');
     * 
     * @example
     * // Execute guild info command
     * await manager.executeCommand(guildId, '/g info');
     * 
     * @example
     * // Kick player
     * await manager.executeCommand(guildId, '/g kick PlayerName');
     */
    async executeCommand(guildId, command, options = {}) {
        if (!this._isStarted || !this._botManager) {
            throw new Error('MinecraftManager not started');
        }

        return this._botManager.executeCommand(guildId, command, options);
    }

    // ==================== Status Methods ====================
    
    /**
     * Get connection status for all guilds
     * 
     * Returns connection status information for all configured guilds.
     * Includes connection state, uptime, and other statistics.
     * Returns empty object if BotManager not initialized.
     * 
     * @returns {object} Connection status object with guild IDs as keys
     * 
     * @example
     * const status = manager.getConnectionStatus();
     * Object.keys(status).forEach(guildId => {
     *   console.log(`${guildId}: ${status[guildId].connected}`);
     * });
     */
    getConnectionStatus() {
        if (!this._botManager) {
            return {};
        }

        return this._botManager.getConnectionStatus();
    }

    /**
     * Check if guild is connected
     * 
     * Checks if a specific guild's bot is currently connected to Minecraft.
     * Returns false if BotManager not initialized or guild not connected.
     * 
     * @param {string} guildId - Guild ID to check
     * @returns {boolean} True if guild is connected, false otherwise
     * 
     * @example
     * if (manager.isGuildConnected('guild123')) {
     *   await manager.sendMessage('guild123', 'Hello!');
     * }
     * 
     * @example
     * // Wait for connection
     * while (!manager.isGuildConnected(guildId)) {
     *   await new Promise(resolve => setTimeout(resolve, 1000));
     * }
     */
    isGuildConnected(guildId) {
        if (!this._botManager) {
            return false;
        }

        return this._botManager.isGuildConnected(guildId);
    }

    /**
     * Get list of connected guilds
     * 
     * Returns array of all currently connected guilds with their information.
     * Each entry includes guild ID, name, and connection details.
     * Returns empty array if BotManager not initialized.
     * 
     * @returns {Array<object>} Array of connected guild objects
     * @returns {string} return[].guildId - Guild ID
     * @returns {string} return[].guildName - Guild name
     * 
     * @example
     * const connected = manager.getConnectedGuilds();
     * console.log(`${connected.length} guilds connected`);
     * connected.forEach(guild => {
     *   console.log(`- ${guild.guildName} (${guild.guildId})`);
     * });
     */
    getConnectedGuilds() {
        if (!this._botManager) {
            return [];
        }

        return this._botManager.getConnectedGuilds();
    }

    // ==================== Discord Integration Access Methods ====================
    
    /**
     * Get Discord manager reference
     * 
     * Returns the Discord manager instance if set, or null if not available.
     * Useful for accessing Discord functionality from Minecraft context.
     * 
     * @returns {object|null} Discord manager instance or null
     * 
     * @example
     * const discordManager = manager.getDiscordManager();
     * if (discordManager) {
     *   // Use Discord functionality
     * }
     */
    getDiscordManager() {
        return this._discordManager;
    }

    /**
     * Get bridge coordinator reference
     * 
     * Returns the BridgeCoordinator instance if integration is setup, or null.
     * Useful for accessing bridge coordination functionality directly.
     * 
     * @returns {object|null} BridgeCoordinator instance or null
     * 
     * @example
     * const coordinator = manager.getBridgeCoordinator();
     * if (coordinator) {
     *   const config = coordinator.getRoutingConfig();
     * }
     */
    getBridgeCoordinator() {
        return this._bridgeCoordinator;
    }

    // ==================== Manual Bot Control Methods ====================

    /**
     * Manually disconnect a specific guild bot.
     *
     * Prevents automatic reconnection until manualStart() is called.
     *
     * @async
     * @param {string} guildId - Guild ID to disconnect
     * @returns {Promise<void>}
     */
    async manualStop(guildId) {
        if (!this._botManager) {
            throw new Error('MinecraftManager not started');
        }
        return this._botManager.manualStop(guildId);
    }

    /**
     * Manually reconnect a specific guild bot.
     *
     * Clears the manual-disconnect flag so auto-reconnect resumes on future crashes.
     *
     * @async
     * @param {string} guildId - Guild ID to reconnect
     * @returns {Promise<void>}
     */
    async manualStart(guildId) {
        if (!this._botManager) {
            throw new Error('MinecraftManager not started');
        }
        return this._botManager.manualStart(guildId);
    }

    /**
     * Check whether a guild bot was manually disconnected.
     *
     * @param {string} guildId - Guild ID to check
     * @returns {boolean}
     */
    isManuallyDisconnected(guildId) {
        if (!this._botManager) return false;
        return this._botManager.isManuallyDisconnected(guildId);
    }

    // ==================== Inter-Guild Configuration Methods ====================
    
    /**
     * Update inter-guild configuration
     * 
     * Updates the inter-guild communication configuration via BotManager.
     * Changes take effect immediately for all guilds. Configuration options
     * include routing rules, rate limits, and feature toggles.
     * 
     * @param {object} newConfig - New configuration options to merge
     * @param {boolean} [newConfig.enabled] - Enable/disable inter-guild
     * @param {boolean} [newConfig.showTags] - Show guild tags in messages
     * 
     * @example
     * manager.updateInterGuildConfig({
     *   enabled: true,
     *   showTags: true
     * });
     * 
     * @example
     * // Disable inter-guild temporarily
     * manager.updateInterGuildConfig({ enabled: false });
     */
    updateInterGuildConfig(newConfig) {
        if (this._botManager) {
            this._botManager.updateInterGuildConfig(newConfig);
            logger.info('Inter-guild configuration updated via MinecraftManager');
        }
    }

    /**
     * Clear inter-guild cache
     * 
     * Clears all inter-guild caches including message history, rate limiters,
     * and anti-loop tracking data via BotManager. Useful for troubleshooting
     * or resetting after configuration changes.
     * 
     * @example
     * manager.clearInterGuildCache();
     * 
     * @example
     * // Clear cache after config change
     * manager.updateInterGuildConfig(newConfig);
     * manager.clearInterGuildCache();
     */
    clearInterGuildCache() {
        if (this._botManager) {
            this._botManager.clearInterGuildCache();
            logger.info('Inter-guild cache cleared via MinecraftManager');
        }
    }
}

module.exports = MinecraftManager;