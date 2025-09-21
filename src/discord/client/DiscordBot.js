// Globals Imports
const { Client, GatewayIntentBits, ActivityType } = require('discord.js');
const EventEmitter = require('events');

// Specific Imports
const BridgeLocator = require("../../bridgeLocator.js");
const MessageHandler = require("./handlers/MessageHandler.js");
const logger = require("../../shared/logger");

class DiscordBot extends EventEmitter {
    constructor() {
        super();

        const mainBridge = BridgeLocator.getInstance();
        this.config = mainBridge.config;

        this.client = null;
        this._isConnected = false;
        this._isReady = false;
        this.connectionAttempts = 0;
        this.maxConnectionAttempts = 5;
        this.reconnectTimeout = null;

        // Handlers
        this.messageHandler = null;

        this.initializeClient();
    }

    initializeClient() {
        try {
            // Create Discord client with necessary intents
            this.client = new Client({
                intents: [
                    GatewayIntentBits.Guilds,
                    GatewayIntentBits.GuildMessages,
                    GatewayIntentBits.MessageContent,
                    GatewayIntentBits.GuildMembers
                ]
            });

            // Initialize handlers (but don't initialize them with client yet)
            this.messageHandler = new MessageHandler();

            this.setupEventHandlers();
            
            logger.discord('Discord client initialized with intents');

        } catch (error) {
            logger.logError(error, 'Failed to initialize Discord client');
            throw error;
        }
    }

    setupEventHandlers() {
        // Ready event
        this.client.on('ready', async () => {
            this._isConnected = true;
            this._isReady = true;
            
            const botInfo = {
                username: this.client.user.username,
                id: this.client.user.id,
                discriminator: this.client.user.discriminator,
                tag: this.client.user.tag
            };

            logger.discord(`✅ Discord bot logged in as ${botInfo.tag}`);

            try {
                // Initialize handlers with the Discord client now that it's ready
                await this.initializeHandlers();

                // Set bot activity/status
                this.setBotActivity();

                // Emit connection event
                this.emit('connection', {
                    type: 'connected',
                    bot: botInfo,
                    guilds: this.client.guilds.cache.size,
                    users: this.client.users.cache.size
                });

            } catch (error) {
                logger.logError(error, 'Failed to initialize handlers after Discord ready');
                this.emit('error', error);
            }
        });

        // Disconnect event
        this.client.on('disconnect', () => {
            this._isConnected = false;
            this._isReady = false;
            
            logger.discord('🔴 Discord bot disconnected');
            
            this.emit('connection', {
                type: 'disconnected'
            });

            // Schedule reconnection
            this.scheduleReconnection();
        });

        // Error event
        this.client.on('error', (error) => {
            logger.logError(error, 'Discord bot error');
            
            this.emit('error', error);
        });

        // Warning event
        this.client.on('warn', (warning) => {
            logger.warn(`Discord bot warning: ${warning}`);
        });

        // Message event - handle both regular messages and commands
        this.client.on('messageCreate', async (message) => {            
            if (!this._isReady)
                return;

            // Handle regular message
            if (this.messageHandler) {
                await this.messageHandler.handleMessage(message);
            }
        });

        // Guild member add
        this.client.on('guildMemberAdd', (member) => {
            logger.debug(`New member joined: ${member.user.tag}`);
            this.emit('memberJoin', member);
        });

        // Guild member remove
        this.client.on('guildMemberRemove', (member) => {
            logger.debug(`Member left: ${member.user.tag}`);
            this.emit('memberLeave', member);
        });

        // Rate limit handling
        this.client.on('rateLimit', (info) => {
            logger.warn(`Discord rate limit hit: ${JSON.stringify(info)}`);
        });

        // Shard events
        this.client.on('shardError', (error) => {
            logger.logError(error, 'Discord shard error');
        });

        this.client.on('shardReady', () => {
            logger.debug('Discord shard ready');
        });
    }

    /**
     * Setup message handler event forwarding
     */
    setupMessageHandlerEvents() {
        if (!this.messageHandler) {
            logger.warn('MessageHandler not available for event setup');
            return;
        }

        // Forward message events from MessageHandler
        this.messageHandler.on('message', (messageData) => {
            logger.debug(`[DISCORD-BOT] Message event from MessageHandler: ${JSON.stringify(messageData)}`);
            this.emit('message', messageData);
        });

        // Forward command events from MessageHandler  
        this.messageHandler.on('command', (commandData) => {
            logger.debug(`[DISCORD-BOT] Command event from MessageHandler: ${JSON.stringify(commandData)}`);
            this.emit('command', commandData);
        });

        logger.debug('DiscordBot message handler events setup completed');
    }

    /**
     * Update initializeHandlers method
     */
    async initializeHandlers() {
        try {
            // Initialize message handler
            if (this.messageHandler) {
                await this.messageHandler.initialize(this.client);
                
                // Set up message handler event forwarding
                this.setupMessageHandlerEvents();
                
                logger.debug('Message handler initialized and events setup');
            }

            logger.debug('All Discord bot handlers initialized');

        } catch (error) {
            logger.logError(error, 'Failed to initialize Discord bot handlers');
            throw error;
        }
    }

    setBotActivity() {
        try {
            const activityConfig = this.config.get('bridge.activity') || {};
            
            if (activityConfig.enabled !== false) {
                const activity = {
                    name: activityConfig.name || 'Minecraft Bridge',
                    type: ActivityType[activityConfig.type] || ActivityType.Playing
                };

                this.client.user.setActivity(activity.name, { type: activity.type });
                logger.debug(`Set bot activity: ${activity.name} (${activity.type})`);
            }

        } catch (error) {
            logger.logError(error, 'Failed to set bot activity');
        }
    }

    async start() {
        try {
            logger.discord('Starting Discord bot...');

            const token = this.config.get('app.token');
            if (!token) {
                throw new Error('Discord bot token not configured');
            }

            // Reset connection state before starting
            this._isConnected = false;
            this._isReady = false;

            this.connectionAttempts++;
            logger.discord(`Starting Discord bot (attempt ${this.connectionAttempts}/${this.maxConnectionAttempts})`);

            // Check if client already exists and is connected
            if (this.client && this.client.readyTimestamp) {
                logger.debug('Discord client appears to be connected already, checking status...');
                
                // Test if client is actually working
                try {
                    await this.client.user.fetch();
                    this._isConnected = true;
                    this._isReady = true;
                    logger.discord('✅ Discord bot was already connected and working');
                    return;
                } catch (error) {
                    logger.debug('Existing client not working, will reconnect');
                    // Destroy the existing client
                    this.client.destroy();
                    this.client = null;
                }
            }

            // Create fresh client if needed
            if (!this.client) {
                this.initializeClient();
            }

            // Login to Discord
            await this.client.login(token);

            // Wait for ready event with timeout
            await this.waitForReady(30000); // 30 second timeout

            logger.discord('✅ Discord bot started successfully');

        } catch (error) {
            logger.logError(error, `Failed to start Discord bot (attempt ${this.connectionAttempts}/${this.maxConnectionAttempts})`);
            
            if (this.connectionAttempts < this.maxConnectionAttempts) {
                this.scheduleReconnection();
            } else {
                logger.error('Max connection attempts reached. Discord bot startup failed.');
                this.emit('error', new Error('Max connection attempts reached'));
            }
            
            throw error;
        }
    }

    async stop() {
        if (!this._isConnected && !this.client) {
            logger.debug('Discord bot not connected, nothing to stop');
            return;
        }

        try {
            logger.discord('Stopping Discord bot...');

            // Clear reconnection timeout
            if (this.reconnectTimeout) {
                clearTimeout(this.reconnectTimeout);
                this.reconnectTimeout = null;
            }

            // Cleanup handlers
            if (this.messageHandler) {
                this.messageHandler.cleanup();
            }

            // Destroy Discord client
            if (this.client) {
                this.client.destroy();
            }

            this._isConnected = false;
            this._isReady = false;
            this.connectionAttempts = 0;

            logger.discord('✅ Discord bot stopped');

        } catch (error) {
            logger.logError(error, 'Error stopping Discord bot');
            throw error;
        }
    }

    scheduleReconnection() {
        if (this.reconnectTimeout) {
            return; // Reconnection already scheduled
        }

        if (this.connectionAttempts >= this.maxConnectionAttempts) {
            logger.error('Max reconnection attempts reached. Giving up.');
            return;
        }

        const delay = Math.min(5000 * this.connectionAttempts, 30000); // Exponential backoff, max 30s
        
        logger.discord(`Scheduling Discord reconnection in ${delay}ms (attempt ${this.connectionAttempts + 1}/${this.maxConnectionAttempts})`);
        
        this.reconnectTimeout = setTimeout(async () => {
            this.reconnectTimeout = null;
            
            try {
                await this.start();
            } catch (error) {
                logger.logError(error, 'Reconnection failed');
            }
        }, delay);
    }

    waitForReady(timeout = 10000) {
        return new Promise((resolve, reject) => {
            if (this._isReady) {
                resolve();
                return;
            }

            const timeoutHandle = setTimeout(() => {
                reject(new Error('Discord bot ready timeout'));
            }, timeout);

            this.client.once('ready', () => {
                clearTimeout(timeoutHandle);
                resolve();
            });

            this.client.once('error', (error) => {
                clearTimeout(timeoutHandle);
                reject(error);
            });
        });
    }

    // ==================== GETTER METHODS ====================

    getClient() {
        return this.client;
    }

    isConnected() {
        return this._isConnected && this._isReady;
    }

    getConnectionStatus() {
        return {
            connected: this._isConnected,
            ready: this._isReady,
            attempts: this.connectionAttempts,
            maxAttempts: this.maxConnectionAttempts,
            guilds: this.client ? this.client.guilds.cache.size : 0,
            users: this.client ? this.client.users.cache.size : 0
        };
    }

    getBotInfo() {
        if (!this.client || !this.client.user) {
            return null;
        }

        return {
            username: this.client.user.username,
            id: this.client.user.id,
            discriminator: this.client.user.discriminator,
            tag: this.client.user.tag,
            avatar: this.client.user.displayAvatarURL(),
            verified: this.client.user.verified,
            bot: this.client.user.bot
        };
    }

    // ==================== EVENT FORWARDING METHODS ====================

    onMessage(callback) {
        this.on('message', callback);
    }

    onCommand(callback) {
        this.on('command', callback);
    }

    onConnection(callback) {
        this.on('connection', callback);
    }

    onError(callback) {
        this.on('error', callback);
    }

    onMemberJoin(callback) {
        this.on('memberJoin', callback);
    }

    onMemberLeave(callback) {
        this.on('memberLeave', callback);
    }
}

module.exports = DiscordBot;