// Globals Imports
const mineflayer = require('mineflayer');

// Specific Imports
const logger = require("../../shared/logger");
const StrategyManager = require("../servers/StrategyManager.js")

class MinecraftConnection {
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
    }

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

    async createBot() {
        // Prepare bot configuration
        const botConfig = {
            host: this._guildConfig.server.host,
            port: this._guildConfig.server.port,
            username: this._guildConfig.account.username,
            version: this._guildConfig.server.version,
            auth: this._guildConfig.account.authMethod || 'microsoft',
            viewDistance: this._guildConfig.account.viewDistance || 'tiny',
            chatLengthLimit: this._guildConfig.account.chatLengthLimit || 256,
            checkTimeoutInterval: 30000, // 30 seconds
            keepAlive: this._guildConfig.account.keepAlive !== false // true by default
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

        logger.debug(`Creating bot for ${this._guildConfig.name}:`, {
            host: botConfig.host,
            port: botConfig.port,
            username: botConfig.username,
            version: botConfig.version,
            auth: botConfig.auth
        });

        // Create the bot
        this._bot = mineflayer.createBot(botConfig);

        // Setup event handlers
        this.setupEventHandlers();
    }

    async waitForSpawn() {
        return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                reject(new Error(`Spawn timeout after 60 seconds for ${this._guildConfig.name}`));
            }, 60000); // 60 second timeout

            this._bot.once('spawn', () => {
                clearTimeout(timeout);
                logger.minecraft(`Bot spawned successfully for ${this._guildConfig.name}`);
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

    calculateReconnectDelay() {
        // Exponential backoff with jitter
        const baseDelay = this._guildConfig.account.reconnection?.retryDelay || 30000;
        const backoffMultiplier = Math.min(this._connectionAttempts, 5); // Cap at 5x
        const jitter = Math.random() * 5000; // 0-5 second jitter
        
        return baseDelay * backoffMultiplier + jitter;
    }

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
            logger.minecraft(`Login successful for ${this._guildConfig.name}`);
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
     * @param {object} message - Raw message from Minecraft
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
                logger.debug(`[${this._guildConfig.name}] Non-guild message ignored: ${message.toString().substring(0, 50)}...`);
            }
            
        } catch (error) {
            logger.logError(error, `Error handling message for ${this._guildConfig.name}`);
        }
    }

    /**
     * Set callback for guild messages
     * @param {function} callback - Callback function for guild messages
     */
    setMessageCallback(callback) {
        this.messageCallback = callback;
    }

    /**
     * Set callback for guild events
     * @param {function} callback - Callback function for guild events
     */
    setEventCallback(callback) {
        this.eventCallback = callback;
    }

    async sendMessage(message) {
        if (!this._isConnected || !this._bot) {
            throw new Error(`Cannot send message: ${this._guildConfig.name} is not connected`);
        }

        try {
            // Respect chat length limit
            const maxLength = this._guildConfig.account.chatLengthLimit || 256;
            const truncatedMessage = message.length > maxLength 
                ? message.substring(0, maxLength - 3) + '...'
                : message;

            this._bot.chat(truncatedMessage);
            logger.debug(`Message sent for ${this._guildConfig.name}: ${truncatedMessage}`);
        
        } catch (error) {
            logger.logError(error, `Failed to send message for ${this._guildConfig.name}`);
            throw error;
        }
    }

    async executeCommand(command) {
        if (!this._isConnected || !this._bot) {
            throw new Error(`Cannot execute command: ${this._guildConfig.name} is not connected`);
        }

        try {
            // Check if command is allowed
            const allowedCommands = this._guildConfig.commands?.allowedCommands || [];
            const commandName = command.split(' ')[0].replace('/', '');
            
            if (!allowedCommands.includes(commandName)) {
                throw new Error(`Command '${commandName}' is not allowed for ${this._guildConfig.name}`);
            }

            this._bot.chat(command);        
        } catch (error) {
            logger.logError(error, `Failed to execute command for ${this._guildConfig.name}`);
            throw error;
        }
    }

    async disconnect(logAsNormal = true) {
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

    // Utility methods
    wait(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    // Getters for status checking
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
    
    isconnected() {
        return this._isConnected;
    }

    getBot() {
        return this._bot;
    }

    getGuildConfig() {
        return this._guildConfig;
    }
}

module.exports = MinecraftConnection;