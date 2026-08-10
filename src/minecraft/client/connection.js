/**
 * Minecraft Connection Manager - Bot Connection Lifecycle Management
 * 
 * This file manages the complete lifecycle of Minecraft bot connections, including
 * connection establishment, authentication, reconnection handling, message processing,
 * and disconnection. It serves as the core interface between the bot management system
 * and the Mineflayer library.
 * 
 * Key features:
 * - Connection establishment with retry logic and exponential backoff
 * - Microsoft authentication with visual code display
 * - Session caching for faster reconnections
 * - Automatic reconnection with strategy-based post-connection handling
 * - Guild message filtering and routing
 * - Health monitoring and automatic respawn
 * - Connection status tracking and reporting
 * - Message sending (guild chat, officer chat, commands)
 * 
 * The connection manager integrates with StrategyManager to apply server-specific
 * behaviors (like Hypixel's limbo system) after connection and reconnection events.
 * 
 * Connection flow:
 * 1. Create bot with authentication
 * 2. Wait for spawn event
 * 3. Apply post-connection strategy
 * 4. Setup event handlers
 * 5. Monitor health and messages
 * 
 * @author Fabien83560
 * @version 1.0.0
 * @license ISC
 */

// Globals Imports
const mineflayer = require('mineflayer');

// Specific Imports
const logger = require("../../shared/logger");
const StrategyManager = require("../servers/StrategyManager.js")
const ChatQueue = require("./ChatQueue.js");
const BridgeLocator = require("../../bridgeLocator.js");

/**
 * MinecraftConnection - Manages individual bot connections
 * 
 * Handles all aspects of a single bot's connection to a Minecraft server,
 * including authentication, reconnection, message handling, and health monitoring.
 * 
 * @class
 */
class MinecraftConnection {
    /**
     * Initialize a new Minecraft connection for a guild
     * 
     * Sets up connection tracking, retry configuration, and strategy management.
     * Does not automatically connect - call connect() to establish connection.
     * 
     * @param {object} guildConfig - Guild configuration object
     * @param {string} guildConfig.id - Guild ID
     * @param {string} guildConfig.name - Guild name
     * @param {string} guildConfig.tag - Guild tag
     * @param {object} guildConfig.account - Account configuration
     * @param {string} guildConfig.account.username - Minecraft username
     * @param {string} guildConfig.account.authMethod - Authentication method
     * @param {object} guildConfig.server - Server configuration
     * @param {string} guildConfig.server.host - Server host
     * @param {number} guildConfig.server.port - Server port
     * @param {string} guildConfig.server.version - Minecraft version
     * 
     * @example
     * const connection = new MinecraftConnection({
     *   id: 'guild1',
     *   name: 'MyGuild',
     *   account: { username: 'BotName', authMethod: 'microsoft' },
     *   server: { host: 'mc.hypixel.net', port: 25565 }
     * });
     */
    constructor(guildConfig) {
        this._guildConfig = guildConfig;

        this._bot = null;
        this._connectionAttempts = 0;
        this._maxConnectionAttempts = 5;

        this.strategyManager = new StrategyManager();

        this._isConnected = false;
        this._isConnecting = false;
        this.lastConnectionTime = null;
        this.connectionStartTime = null;

        // Event callbacks
        this.messageCallback = null;
        this.eventCallback = null;

        // Serialized outbound chat. Every write to this account goes through here so
        // that Discord bridging, inter-guild relaying and slash commands can never
        // collide inside the same tick and get silently discarded by the server.
        this._chatQueue = new ChatQueue(
            guildConfig,
            {
                isConnected: () => this._isConnected && !!this._bot,
                rawSend: (text) => this._bot.chat(text)
            },
            this.getQueueOptions()
        );
    }

    /**
     * Build ChatQueue options from configuration
     *
     * Reads bridge.minecraftQueue when present. When it is absent the minimum interval
     * is derived from the legacy bridge.rateLimit.minecraft window/limit pair so an
     * un-migrated configuration still gets sane pacing rather than no pacing at all.
     *
     * @returns {object} Options object for the ChatQueue constructor
     *
     * @example
     * const options = connection.getQueueOptions();
     * // { minIntervalMs: 1200, jitterMs: 250, maxSize: 200, ... }
     */
    getQueueOptions() {
        let config = null;

        try {
            config = BridgeLocator.getInstance().config;
        } catch (error) {
            logger.debug('Config unavailable for ChatQueue options, using defaults');
        }

        const queueConfig = config?.get('bridge.minecraftQueue') || {};
        const legacyRateLimit = config?.get('bridge.rateLimit.minecraft') || {};

        // Derive a per-message interval from the old limit/window pair when the
        // dedicated queue settings are not configured
        const derivedInterval = legacyRateLimit.limit > 0 && legacyRateLimit.window > 0
            ? Math.ceil(legacyRateLimit.window / legacyRateLimit.limit)
            : 1200;

        return {
            minIntervalMs: queueConfig.minIntervalMs ?? Math.max(derivedInterval, 1200),
            jitterMs: queueConfig.jitterMs ?? 250,
            maxSize: queueConfig.maxSize ?? 200,
            antiDuplicate: queueConfig.antiDuplicate !== false,
            duplicateSuffix: queueConfig.duplicateSuffix ?? 'ᐧ',
            duplicateWindowMs: queueConfig.duplicateWindowMs ?? 60000
        };
    }

    /**
     * Establish connection to Minecraft server
     * 
     * Creates bot instance, waits for spawn, and applies post-connection strategy.
     * Implements retry logic with connection attempt tracking.
     * 
     * Process:
     * 1. Check if already connecting
     * 2. Create bot instance with authentication
     * 3. Wait for successful spawn (240s timeout)
     * 4. Apply server-specific post-connection strategy
     * 5. Reset retry counter on success
     * 
     * @returns {Promise<void>}
     * @throws {Error} If connection fails after max attempts or spawn timeout
     * 
     * @example
     * await connection.connect();
     * console.log('Bot connected successfully');
     */
    async connect() {
        if(this._isConnecting) {
            logger.warn(`Connection already in progress for ${this._guildConfig.name}`);
            return;
        }

        this._isConnecting = true;
        this._connectionStartTime = Date.now();
        this._connectionAttempts++;
        try {
            logger.logMinecraftConnection(
                this._guildConfig.id, 
                this._guildConfig.account.username, 
                'connecting',
                {
                    attempt: this._connectionAttempts,
                    server: this._guildConfig.server.serverName,
                    host: this._guildConfig.server.host
                }
            );

            // Create Minecraft bot instance
            await this.createBot();
            
            // Wait for successful spawn
            await this.waitForSpawn();
            
            // Mark as connected
            this._isConnected = true;
            this._isConnecting = false;
            this._lastConnectionTime = Date.now();

            // A fresh session starts with a fresh server-side rate limit, so clear the
            // pacing timestamp and duplicate history from the previous connection
            this._chatQueue.resetPacing();
            
            // Log successful connection with performance info
            const connectionTime = Date.now() - this._connectionStartTime;
            logger.logMinecraftConnection(
                this._guildConfig.id, 
                this._guildConfig.account.username, 
                'connected',
                {
                    server: this._guildConfig.server.serverName,
                    connectionTime: `${connectionTime}ms`,
                    attempt: this._connectionAttempts
                }
            );

            // Apply post-connection strategy based on server type
            await this.applyPostConnectStrategy();
            
            // Reset connection attempts on success
            this._connectionAttempts = 0;
        } catch (error) {
            this._isConnecting = false;
            this._isConnected = false;
            
            logger.logError(error, `Connection failed for ${this._guildConfig.name} (attempt ${this._connectionAttempts})`);
            
            if (this._connectionAttempts >= this._maxConnectionAttempts) {
                logger.logMinecraftConnection(
                    this._guildConfig.id, 
                    this._guildConfig.account.username, 
                    'failed - max attempts reached',
                    {
                        maxAttempts: this._maxConnectionAttempts,
                    }
                );
                throw new Error(`Max connection attempts (${this._maxConnectionAttempts}) reached for ${this._guildConfig.name}`);
            }
            
            throw error;
        }
    }

    /**
     * Create Mineflayer bot instance with authentication
     * 
     * Configures and creates bot with Microsoft authentication support,
     * session caching, and connection parameters from guild configuration.
     * Displays authentication code for Microsoft accounts.
     * 
     * Bot configuration includes:
     * - Authentication (Microsoft/offline)
     * - Session caching paths
     * - Server connection details
     * - View distance and chat limits
     * - Keep-alive settings
     * 
     * @returns {Promise<void>}
     * @throws {Error} If bot creation fails
     * 
     * @example
     * await connection.createBot();
     * // Bot instance created and stored in this._bot
     */
    async createBot() {
        // Prepare bot configuration
        const botConfig = {
            onMsaCode: (data) => showMicrosoftAuthCode(
                data, 
                this._guildConfig.account.username, 
                this._guildConfig.name,
                this._guildConfig  // Pass complete configuration
            ),

            host: this._guildConfig.server.host,
            port: this._guildConfig.server.port,
            username: this._guildConfig.account.username,
            version: this._guildConfig.server.version,
            auth: this._guildConfig.account.authMethod || 'microsoft',
            viewDistance: this._guildConfig.account.viewDistance || 'tiny',
            chatLengthLimit: this._guildConfig.account.chatLengthLimit || 256,
            checkTimeoutInterval: 30000, // 30 seconds
            keepAlive: this._guildConfig.account.keepAlive !== false, // true by default
        };

        // Add session paths for authentication caching
        if (this._guildConfig.account.sessionPath) {
            botConfig.sessionPath = this._guildConfig.account.sessionPath;
        }
        if (this._guildConfig.account.cachePath) {
            botConfig.cachePath = this._guildConfig.account.cachePath;
        }
        if (this._guildConfig.account.profilesFolder) {
            botConfig.profilesFolder = this._guildConfig.account.profilesFolder;
        }

        // Authentication startup log
        if (botConfig.auth === 'microsoft') {
            logger.info('');
            logger.info('🔐 Starting Microsoft authentication...');
            logger.info(`   Bot: ${this._guildConfig.name} (${botConfig.username})`);
            logger.info(`   Server: ${this._guildConfig.server.serverName}`);
            logger.info('');
        }

        logger.debug(`Creating bot for ${this._guildConfig.name}:`, {
            host: botConfig.host,
            port: botConfig.port,
            username: botConfig.username,
            version: botConfig.version,
            auth: botConfig.auth
        });

        try {
            // Create the bot
            this._bot = mineflayer.createBot(botConfig);

            // Authentication success log
            if (botConfig.auth === 'microsoft') {
                this._bot.once('login', () => {
                    logger.info('');
                    logger.info('==================================================================');
                    logger.info('✅ MICROSOFT AUTHENTICATION SUCCESSFUL');
                    logger.info('==================================================================');
                    logger.info(`🤖 BOT: ${this._guildConfig.name} (${botConfig.username})`);
                    logger.info(`🎮 SERVER: ${this._guildConfig.server.serverName}`);
                    logger.info('✅ Bot is now connected and operational');
                    logger.info('==================================================================');
                    logger.info('');
                });

                this._bot.once('error', (error) => {
                    if (error.message.includes('auth') || error.message.includes('login') || error.message.includes('microsoft')) {
                        logger.info('');
                        logger.info('==================================================================');
                        logger.info('❌ MICROSOFT AUTHENTICATION FAILED');
                        logger.info('==================================================================');
                        logger.info(`🤖 BOT: ${this._guildConfig.name} (${botConfig.username})`);
                        logger.info(`❌ Error: ${error.message}`);
                        logger.info('==================================================================');
                        logger.info('');
                    }
                });
            }

            // Setup event handlers
            this.setupEventHandlers();

        } catch (error) {
            if (botConfig.auth === 'microsoft') {
                logger.info('');
                logger.info('==================================================================');
                logger.info('💥 ERROR DURING BOT CREATION');
                logger.info('==================================================================');
                logger.info(`🤖 BOT: ${this._guildConfig.name} (${botConfig.username})`);
                logger.info(`💥 Error: ${error.message}`);
                logger.info('==================================================================');
                logger.info('');
            }
            
            logger.logError(error, `Failed to create bot for ${this._guildConfig.name}`);
            throw error;
        }
    }

    /**
     * Wait for bot to spawn in the Minecraft world
     * 
     * Waits for the 'spawn' event with a 240-second timeout.
     * Handles errors, disconnections, and kicks during spawn.
     * 
     * @returns {Promise<void>}
     * @throws {Error} If spawn timeout, error, disconnect, or kick occurs
     * 
     * @example
     * await connection.waitForSpawn();
     * console.log('Bot spawned successfully');
     */
    async waitForSpawn() {
        return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                reject(new Error(`Spawn timeout after 240 seconds for ${this._guildConfig.name}`));
            }, 240000); // 240 second timeout

            this._bot.once('spawn', () => {
                clearTimeout(timeout);
                logger.minecraft(`✅ Bot spawned successfully for ${this._guildConfig.name}`);
                resolve();
            });

            this._bot.once('error', (error) => {
                clearTimeout(timeout);
                reject(error);
            });

            this._bot.once('end', (reason) => {
                clearTimeout(timeout);
                reject(new Error(`Connection ended during spawn: ${reason}`));
            });

            this._bot.once('kicked', (reason) => {
                clearTimeout(timeout);
                reject(new Error(`Kicked during spawn: ${reason}`));
            });
        });
    }

    /**
     * Apply server-specific post-connection strategy
     * 
     * Executes server-specific behavior after successful connection.
     * For Hypixel: changes language and goes to limbo.
     * Non-critical operation - connection remains valid even if strategy fails.
     * 
     * @returns {Promise<void>}
     * 
     * @example
     * await connection.applyPostConnectStrategy();
     */
    async applyPostConnectStrategy() {
        const serverName = this._guildConfig.server.serverName;
        logger.minecraft(`Applying ${serverName} post-connection strategy for ${this._guildConfig.name}`);

        try {
            await this.strategyManager.executePostConnectStrategy(this._bot, this._guildConfig);
            logger.minecraft(`✅ Post-connection strategy completed for ${this._guildConfig.name}`);
        } catch (error) {
            logger.logError(error, `Post-connection strategy failed for ${this._guildConfig.name}`);
            // Don't throw here - connection is still valid even if strategy fails
        }
    }

    /**
     * Reconnect to Minecraft server
     * 
     * Performs full reconnection with strategy application:
     * 1. Disconnect existing connection
     * 2. Calculate exponential backoff delay
     * 3. Wait for reconnection delay
     * 4. Establish new connection
     * 5. Apply reconnection strategy
     * 
     * @returns {Promise<void>}
     * @throws {Error} If reconnection fails
     * 
     * @example
     * await connection.reconnect();
     * console.log('Bot reconnected successfully');
     */
    async reconnect() {
        logger.minecraft(`🔄 Initiating reconnection for ${this._guildConfig.name}`);
        
        try {
            // Clean up existing connection
            await this.disconnect(false); // Don't log as normal disconnect
            
            // Wait before attempting reconnection
            const reconnectDelay = this.calculateReconnectDelay();
            logger.minecraft(`Waiting ${reconnectDelay}ms before reconnecting ${this._guildConfig.name}`);
            await this.wait(reconnectDelay);

            // Attempt to reconnect
            await this.connect();

            // Apply reconnection strategy
            await this.applyReconnectStrategy();

        } catch (error) {
            logger.logError(error, `Reconnection failed for ${this._guildConfig.name}`);
            throw error;
        }
    }

    /**
     * Apply server-specific reconnection strategy
     * 
     * Executes server-specific behavior after successful reconnection.
     * Similar to post-connection strategy but for reconnection scenarios.
     * Non-critical operation - reconnection remains valid even if strategy fails.
     * 
     * @returns {Promise<void>}
     * 
     * @example
     * await connection.applyReconnectStrategy();
     */
    async applyReconnectStrategy() {
        const serverName = this._guildConfig.server.serverName;
        logger.minecraft(`Applying ${serverName} reconnection strategy for ${this._guildConfig.name}`);

        try {
            await this.strategyManager.executeReconnectStrategy(this._bot, this._guildConfig);
            logger.minecraft(`✅ Reconnection strategy completed for ${this._guildConfig.name}`);
        } catch (error) {
            logger.logError(error, `Reconnection strategy failed for ${this._guildConfig.name}`);
            // Don't throw here - reconnection is still valid
        }
    }

    /**
     * Calculate reconnection delay with exponential backoff
     * 
     * Implements exponential backoff with jitter to avoid thundering herd problem.
     * Delay increases with connection attempts, capped at 5x base delay.
     * Adds random jitter (0-5 seconds) to prevent synchronized reconnections.
     * 
     * Formula: (baseDelay * min(attempts, 5)) + random(0-5000)
     * 
     * @returns {number} Delay in milliseconds
     * 
     * @example
     * const delay = connection.calculateReconnectDelay();
     * // Returns: 30000 * attempts + random(0-5000), capped at 5x
     */
    calculateReconnectDelay() {
        // Exponential backoff with jitter
        const baseDelay = this._guildConfig.account.reconnection?.retryDelay || 30000;
        const backoffMultiplier = Math.min(this._connectionAttempts, 5); // Cap at 5x
        const jitter = Math.random() * 5000; // 0-5 second jitter
        
        return baseDelay * backoffMultiplier + jitter;
    }

    /**
     * Setup event handlers for bot
     * 
     * Configures handlers for:
     * - Connection events (error, end, kicked)
     * - Login events
     * - Health monitoring and auto-respawn
     * - Message processing with guild filtering
     * 
     * All events are logged appropriately for monitoring and debugging.
     */
    setupEventHandlers() {
        // Connection events
        this._bot.on('error', (error) => {
            logger.logError(error, `Bot error for ${this._guildConfig.name}`);
        });

        this._bot.on('end', (reason) => {
            this._isConnected = false;
            logger.logMinecraftConnection(
                this._guildConfig.id, 
                this._guildConfig.account.username, 
                'disconnected',
                { reason: reason || 'unknown' }
            );
        });

        this._bot.on('kicked', (reason, loggedIn) => {
            this._isConnected = false;
            logger.logMinecraftConnection(
                this._guildConfig.id, 
                this._guildConfig.account.username, 
                'kicked',
                {
                    reason: reason,
                    loggedIn: loggedIn
                }
            );
        });

        // Login events
        this._bot.on('login', () => {
            logger.minecraft(`✅ Login successful for ${this._guildConfig.name}`);
        });

        // Health monitoring
        this._bot.on('health', () => {
            if (this._bot.health <= 0) {
                logger.minecraft(`⚠️ Bot died for ${this._guildConfig.name}, respawning...`);
                this._bot.respawn();
            }
        });

        // Message handling - ONLY GUILD MESSAGES NOW
        this._bot.on('message', (message) => {
            try {
                this.handleMessage(message);
            } catch (error) {
                logger.logError(error, `Message handling error for ${this._guildConfig.name}`);
            }
        });
    }

    /**
     * Handle incoming message and filter for guild messages only
     * 
     * Uses strategy manager to detect and classify guild messages.
     * Non-guild messages are ignored completely.
     * Guild messages are forwarded to message callback for further processing.
     * 
     * @param {object} message - Raw message from Minecraft
     * @returns {Promise<void>}
     * 
     * @example
     * // Called automatically by event handler
     * await connection.handleMessage(message);
     */
    async handleMessage(message) {
        try {
            // Use strategy to check if this is a guild message and process it
            const guildMessageData = await this.strategyManager.handleMessage(this._bot, message, this._guildConfig);
            
            if (guildMessageData) {
                // This is a guild-related message, forward it for parsing
                logger.debug(`[${this._guildConfig.name}] Guild message detected: ${guildMessageData.type}`);
                
                // Call the message callback if set (from BotManager)
                if (this.messageCallback) {
                    this.messageCallback(message, guildMessageData);
                }
            } else {
                // Not a guild message, ignore it completely
                logger.debug(`[${this._guildConfig.name}] Non-guild message ignored: ${message.toString()}`);
            }
            
        } catch (error) {
            logger.logError(error, `Error handling message for ${this._guildConfig.name}`);
        }
    }

    /**
     * Set callback for guild messages
     * 
     * Callback is invoked when guild-related messages are detected.
     * Used by BotManager to route messages for parsing and bridging.
     * 
     * @param {function} callback - Callback function (message, guildMessageData) => void
     * 
     * @example
     * connection.setMessageCallback((message, data) => {
     *   console.log('Guild message:', data.type);
     * });
     */
    setMessageCallback(callback) {
        this.messageCallback = callback;
    }

    /**
     * Set callback for guild events
     * 
     * Callback is invoked when guild events are detected.
     * Reserved for future event-specific handling.
     * 
     * @param {function} callback - Callback function for guild events
     * 
     * @example
     * connection.setEventCallback((event) => {
     *   console.log('Guild event:', event.type);
     * });
     */
    setEventCallback(callback) {
        this.eventCallback = callback;
    }

    /**
     * Send message to guild chat
     *
     * Queues a /gc write. The returned promise settles when the message is actually
     * written to the server, not when it is queued, so a caller that awaits it and logs
     * success is reporting a real send rather than an intent to send.
     *
     * @param {string} message - Message to send
     * @param {object} [options={}] - Delivery options
     * @param {string} [options.direction='inter_guild'] - Metrics direction for accounting
     * @returns {Promise<void>} Settles once written, rejects if the message is dropped
     * @throws {Error} If bot is not connected or the queue drops the message
     *
     * @example
     * await connection.sendMessage('Hello guild!');
     */
    async sendMessage(message, options = {}) {
        if (!this._isConnected || !this._bot) {
            throw new Error(`Cannot send message: ${this._guildConfig.name} is not connected`);
        }

        // Length clamping happens inside the queue, which also accounts for any
        // anti-duplicate suffix it may need to append.
        return this._chatQueue.enqueue(`/gc ${message}`, {
            priority: 'chat',
            direction: options.direction || 'inter_guild',
            label: 'guild chat'
        });
    }

    /**
     * Send message to officer chat
     *
     * Queues an /oc write through the same serialized queue as guild chat, so officer
     * and guild traffic share one pacing budget for this account.
     *
     * @param {string} message - Message to send
     * @param {object} [options={}] - Delivery options
     * @param {string} [options.direction='inter_guild'] - Metrics direction for accounting
     * @returns {Promise<void>} Settles once written, rejects if the message is dropped
     * @throws {Error} If bot is not connected or the queue drops the message
     *
     * @example
     * await connection.sendOfficerMessage('Officer announcement');
     */
    async sendOfficerMessage(message, options = {}) {
        if (!this._isConnected || !this._bot) {
            throw new Error(`Cannot send officer message: ${this._guildConfig.name} is not connected`);
        }

        return this._chatQueue.enqueue(`/oc ${message}`, {
            priority: 'chat',
            direction: options.direction || 'inter_guild',
            label: 'officer chat'
        });
    }

    /**
     * Execute arbitrary command on the server
     *
     * Queues the command on the high-priority lane so it drains ahead of relayed chat.
     * Slash commands have a Discord user waiting on a CommandResponseListener with a
     * timeout, so they must not sit behind a backlog of bridged messages.
     *
     * @param {string} command - Command to execute (including /)
     * @param {object} [options={}] - Delivery options
     * @param {string} [options.direction='discord_to_mc'] - Metrics direction for accounting
     * @param {string} [options.priority='command'] - Lane to use ('command' or 'chat')
     * @returns {Promise<void>} Settles once written, rejects if the command is dropped
     * @throws {Error} If bot is not connected or the queue drops the command
     *
     * @example
     * await connection.executeCommand('/g online');
     */
    async executeCommand(command, options = {}) {
        if (!this._isConnected || !this._bot) {
            throw new Error(`Cannot execute command: ${this._guildConfig.name} is not connected`);
        }

        return this._chatQueue.enqueue(command, {
            priority: options.priority || 'command',
            direction: options.direction || 'discord_to_mc',
            label: 'command'
        });
    }

    /**
     * Get outbound queue statistics
     *
     * Exposes queue depth and pacing state for monitoring and status commands.
     *
     * @returns {object} Queue statistics from ChatQueue.getStats()
     *
     * @example
     * const stats = connection.getQueueStats();
     * console.log(`${stats.chatDepth} messages waiting`);
     */
    getQueueStats() {
        return this._chatQueue.getStats();
    }

    /**
     * Disconnect from Minecraft server
     * 
     * Cleanly disconnects bot by removing listeners and calling quit().
     * Optionally logs disconnect as normal operation or silently for reconnection.
     * 
     * @param {boolean} [logAsNormal=true] - Whether to log as normal disconnect
     * @returns {Promise<void>}
     * 
     * @example
     * await connection.disconnect();
     * // Logs disconnect event
     * 
     * @example
     * await connection.disconnect(false);
     * // Silent disconnect for reconnection
     */
    async disconnect(logAsNormal = true) {
        // Reject anything still queued before tearing down the bot, so pending
        // messages are accounted as dropped instead of vanishing with the connection
        this._chatQueue.stop(logAsNormal ? 'disconnect' : 'reconnect');

        if (this._bot) {
            try {
                this._bot.removeAllListeners();
                this._bot.quit();
                
                if (logAsNormal) {
                    logger.logMinecraftConnection(
                        this._guildConfig.id, 
                        this._guildConfig.account.username, 
                        'disconnected',
                        {
                            reason: 'manual disconnect'
                        }
                    );
                }
            } catch (error) {
                logger.logError(error, `Error during disconnect for ${this._guildConfig.name}`);
            }
        }
        
        this._isConnected = false;
        this._isConnecting = false;
        this._bot = null;
    }

    /**
     * Wait for specified milliseconds
     * 
     * Utility method for creating delays in async operations.
     * 
     * @param {number} ms - Milliseconds to wait
     * @returns {Promise<void>}
     * 
     * @example
     * await connection.wait(5000); // Wait 5 seconds
     */
    wait(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    /**
     * Get detailed connection status
     * 
     * Returns comprehensive connection information for monitoring and debugging.
     * 
     * @returns {object} Connection status object
     * @returns {boolean} return.isConnected - Whether bot is connected
     * @returns {boolean} return.isConnecting - Whether connection in progress
     * @returns {number} return.connectionAttempts - Number of connection attempts
     * @returns {number|null} return.lastConnectionTime - Timestamp of last connection
     * @returns {string} return.guildName - Guild name
     * @returns {string} return.guildId - Guild ID
     * @returns {string} return.username - Bot username
     * @returns {string} return.server - Server name
     * 
     * @example
     * const status = connection.getConnectionStatus();
     * console.log(`Connected: ${status.isConnected}`);
     */
    getConnectionStatus() {
        return {
            isConnected: this._isConnected,
            isConnecting: this._isConnecting,
            connectionAttempts: this._connectionAttempts,
            lastConnectionTime: this._lastConnectionTime,
            guildName: this._guildConfig.name,
            guildId: this._guildConfig.id,
            username: this._guildConfig.account.username,
            server: this._guildConfig.server.serverName
        };
    }
    
    /**
     * Check if bot is connected
     * 
     * @returns {boolean} Whether bot is currently connected
     * 
     * @example
     * if (connection.isconnected()) {
     *   await connection.sendMessage('Hello!');
     * }
     */
    isconnected() {
        return this._isConnected;
    }

    /**
     * Get bot instance
     * 
     * Returns the underlying Mineflayer bot instance.
     * Use with caution - direct bot manipulation may break connection management.
     * 
     * @returns {object|null} Mineflayer bot instance or null if not connected
     * 
     * @example
     * const bot = connection.getBot();
     * if (bot) {
     *   console.log(`Bot health: ${bot.health}`);
     * }
     */
    getBot() {
        return this._bot;
    }

    /**
     * Get guild configuration
     * 
     * @returns {object} Guild configuration object
     * 
     * @example
     * const config = connection.getGuildConfig();
     * console.log(`Guild: ${config.name}`);
     */
    getGuildConfig() {
        return this._guildConfig;
    }
}

/**
 * Display Microsoft authentication code with enhanced information
 * 
 * Displays authentication code in a visually clear format with:
 * - Authentication code and verification URL
 * - Bot and guild information
 * - Expiration time and polling interval
 * - Step-by-step authentication instructions
 * - Important warnings and notes
 * 
 * Called automatically by Mineflayer during Microsoft authentication flow.
 * 
 * @param {object} data - Authentication code data from Microsoft
 * @param {string} data.user_code - Code to enter on Microsoft website
 * @param {string} data.verification_uri - URL to visit for authentication
 * @param {string} [data.verification_uri_complete] - Direct authentication link
 * @param {number} data.expires_in - Code expiration time in seconds
 * @param {number} [data.interval] - Polling interval in seconds
 * @param {string} [accountName='Unknown'] - Minecraft account username
 * @param {string} [guildName='Unknown'] - Guild name
 * @param {object|null} [guildConfig=null] - Complete guild configuration
 * 
 * @example
 * showMicrosoftAuthCode(
 *   {
 *     user_code: 'ABC123',
 *     verification_uri: 'https://microsoft.com/link',
 *     expires_in: 900
 *   },
 *   'BotName',
 *   'MyGuild',
 *   guildConfig
 * );
 */
function showMicrosoftAuthCode(data, accountName = 'Unknown', guildName = 'Unknown', guildConfig = null) {
    // Check if data is valid
    if (!data || !data.user_code || !data.verification_uri) {
        logger.info('');
        logger.info('==================================================================');
        logger.info(`       AUTHENTICATION CODE GENERATION ERROR       `);
        logger.info(`       ACCOUNT: ${accountName} (GUILD: ${guildName})                  `);
        logger.info('==================================================================');
        logger.info('');
        logger.info('❌ Unable to generate Microsoft authentication code.');
        logger.info('❌ Please check authentication configuration.');
        logger.info('');
        return;
    }

    // Prepare additional information
    const additionalInfo = guildConfig ? {
        guildTag: guildConfig.tag || 'No Tag',
        email: guildConfig.account.email || 'Not specified',
        sessionPath: guildConfig.account.sessionPath || 'Default',
        server: guildConfig.server.serverName || 'Unknown',
        authMethod: guildConfig.account.authMethod || 'microsoft'
    } : {};

    // Display code visibly using logger.info
    logger.info('');
    logger.info('==================================================================');
    logger.info(`     MICROSOFT AUTHENTICATION CODE FOR ${accountName}     `);
    logger.info('==================================================================');
    logger.info('');
    logger.info(`🤖 MINECRAFT BOT: ${accountName}`);
    logger.info(`🏰 GUILD: ${guildName} ${additionalInfo.guildTag ? `(${additionalInfo.guildTag})` : ''}`);
    if (additionalInfo.email) {
        logger.info(`📧 ACCOUNT EMAIL: ${additionalInfo.email}`);
    }
    if (additionalInfo.server) {
        logger.info(`🎮 SERVER: ${additionalInfo.server}`);
    }
    if (additionalInfo.sessionPath && additionalInfo.sessionPath !== 'Default') {
        logger.info(`📁 SESSION PATH: ${additionalInfo.sessionPath}`);
    }
    logger.info('');
    logger.info('🔑 AUTHENTICATION CODE:');
    logger.info(`   ➤ ${data.user_code}`);
    logger.info('');
    logger.info('🌐 AUTHENTICATION LINK:');
    logger.info(`   ➤ ${data.verification_uri}`);
    if (data.verification_uri_complete) {
        logger.info(`   ➤ DIRECT LINK: ${data.verification_uri_complete}`);
    }
    logger.info('');
    
    // Timing information
    const expirationMinutes = Math.floor(data.expires_in / 60);
    const expirationSeconds = data.expires_in % 60;
    logger.info(`⏱️  EXPIRATION: ${expirationMinutes}m ${expirationSeconds}s`);
    
    if (data.interval) {
        logger.info(`🔄 POLLING INTERVAL: ${data.interval}s`);
    }
    
    logger.info('');
    logger.info('==================================================================');
    logger.info('📋 AUTHENTICATION INSTRUCTIONS:');
    logger.info('==================================================================');
    logger.info('1. 🌐 Open the URL link in your web browser');
    logger.info(`2. 🔑 Enter the code: ${data.user_code}`);
    logger.info('3. 🔐 Sign in to the Microsoft account that owns Minecraft');
    logger.info(`4. ✅ Bot ${accountName} will connect automatically`);
    logger.info('');
    logger.info('⚠️  IMPORTANT:');
    logger.info(`   • This code belongs ONLY to bot: ${accountName}`);
    logger.info(`   • Associated guild: ${guildName}`);
    logger.info(`   • Do not share this code with other people`);
    logger.info(`   • Code expires in ${expirationMinutes} minute(s)`);
    logger.info('==================================================================');
    logger.info('');
}

module.exports = MinecraftConnection;