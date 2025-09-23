// Globals Imports
const { Client, GatewayIntentBits, ActivityType } = require('discord.js');
const EventEmitter = require('events');

// Specific Imports
const BridgeLocator = require("../../bridgeLocator.js");
const MessageHandler = require("./handlers/MessageHandler.js");
const SlashCommandHandler = require("./handlers/SlashCommandHandler.js");

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
        this.slashCommandHandler = null;

        this.initializeClient();
    }

    initializeClient() {
        try {
            // Create Discord client with necessary intents (including reactions for error handling)
            this.client = new Client({
                intents: [
                    GatewayIntentBits.Guilds,
                    GatewayIntentBits.GuildMessages,
                    GatewayIntentBits.MessageContent,
                    GatewayIntentBits.GuildMembers,
                    GatewayIntentBits.GuildMessageReactions // Added for error handling reactions
                ]
            });

            // Initialize handlers (but don't initialize them with client yet)
            this.messageHandler = new MessageHandler();
            this.slashCommandHandler = new SlashCommandHandler();

            this.setupEventHandlers();
            
            logger.discord('Discord client initialized with intents (including reactions)');

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
     * Setup slash command handler event forwarding
     */
    setupSlashCommandHandlerEvents() {
        if (!this.slashCommandHandler) {
            logger.warn('SlashCommandHandler not available for event setup');
            return;
        }

        // Forward slash command events
        this.slashCommandHandler.on('slashCommand', (commandData) => {
            logger.debug(`[DISCORD-BOT] Slash command event: ${JSON.stringify(commandData)}`);
            this.emit('slashCommand', commandData);
            this.stats.slashCommandsProcessed++;
        });

        logger.debug('DiscordBot slash command handler events setup completed');
    }

    /**
     * Initialize all handlers with Discord client
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

            // Initialize slash command handler
            if (this.slashCommandHandler) {
                await this.slashCommandHandler.initialize(this.client);
                
                // Set up slash command handler event forwarding
                this.setupSlashCommandHandlerEvents();
                
                logger.debug('Slash command handler initialized and events setup');
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

            logger.debug(`Connection attempt ${this.connectionAttempts}/${this.maxConnectionAttempts}`);

            // Login to Discord
            await this.client.login(token);

            await this.waitForReady();

            logger.discord('✅ Discord bot started successfully');

        } catch (error) {
            logger.logError(error, 'Failed to start Discord bot');

            if (this.connectionAttempts < this.maxConnectionAttempts) {
                this.scheduleReconnection();
                logger.logError(error, `Discord bot startup failed (attempt ${this.connectionAttempts}/${this.maxConnectionAttempts})`);
            }

            throw error;
        }
    }

    async waitForReady(timeout = 30000) {
        return new Promise((resolve, reject) => {
            if (this._isReady) {
                resolve();
                return;
            }

            const timeoutId = setTimeout(() => {
                reject(new Error('Discord bot ready timeout'));
            }, timeout);

            const onReady = () => {
                clearTimeout(timeoutId);
                this.removeListener('error', onError);
                resolve();
            };

            const onError = (error) => {
                clearTimeout(timeoutId);
                this.removeListener('ready', onReady);
                reject(error);
            };

            this.once('connection', (data) => {
                if (data.type === 'connected') {
                    onReady();
                }
            });

            this.once('error', onError);
        });
    }

    async stop() {
        if (!this._isConnected && !this.client) {
            logger.debug('Discord bot not connected, nothing to stop');
            return;
        }

        const delay = Math.min(5000 * Math.pow(2, this.connectionAttempts - 1), 300000); // Exponential backoff, max 5 minutes
        
        logger.discord(`Scheduling reconnection in ${delay / 1000} seconds...`);

        this.reconnectTimeout = setTimeout(async () => {
            try {
                this.stats.reconnections++;
                await this.start();
            } catch (error) {
                logger.logError(error, 'Reconnection attempt failed');
            }
        }, delay);
    }

    async stop() {
        try {
            logger.discord('Stopping Discord bot...');

            // Clear reconnection timeout
            if (this.reconnectTimeout) {
                clearTimeout(this.reconnectTimeout);
                this.reconnectTimeout = null;
            }

            // Reset states
            this._isConnected = false;
            this._isReady = false;

            // Cleanup handlers
            if (this.messageHandler) {
                this.messageHandler.cleanup();
            }

            if (this.slashCommandHandler) {
                this.slashCommandHandler.cleanup();
            }

            // Destroy Discord client
            if (this.client) {
                await this.client.destroy();
                this.client = null;
            }

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
            this.emit('error', new Error('Max reconnection attempts reached'));
            return;
        }

        const reconnectDelay = Math.min(5000 * this.connectionAttempts, 30000); // Exponential backoff, max 30s
        
        logger.discord(`Scheduling reconnection in ${reconnectDelay}ms...`);
        
        this.reconnectTimeout = setTimeout(async () => {
            this.reconnectTimeout = null;
            
            try {
                logger.discord('Attempting to reconnect...');
                await this.start();
            } catch (error) {
                logger.logError(error, 'Reconnection failed');
                this.scheduleReconnection(); // Schedule another attempt
            }
        }, reconnectDelay);
    }

    // ==================== EVENT REGISTRATION METHODS ====================

    /**
     * Register callback for message events
     * @param {function} callback - Message event callback
     */
    onMessage(callback) {
        this.on('message', callback);
        logger.debug('Message handler registered on DiscordBot');
    }

    /**
     * Register callback for connection events
     * @param {function} callback - Connection event callback
     */
    onConnection(callback) {
        this.on('connection', callback);
        logger.debug('Connection handler registered on DiscordBot');
    }

    /**
     * Register callback for error events
     * @param {function} callback - Error event callback
     */
    onError(callback) {
        this.on('error', callback);
        logger.debug('Error handler registered on DiscordBot');
    }

    // ==================== STATUS METHODS ====================

    isConnected() {
        return this._isConnected && this._isReady;
    }

    isReady() {
        return this._isReady;
    }

    getConnectionStatus() {
        return {
            connected: this._isConnected,
            ready: this._isReady,
            attempts: this.connectionAttempts,
            maxAttempts: this.maxConnectionAttempts
        };
    }

    /**
     * Reload slash commands
     */
    async reloadSlashCommands() {
        if (!this.slashCommandHandler) {
            throw new Error('SlashCommandHandler not available');
        }

        return {
            username: this.client.user.username,
            tag: this.client.user.tag,
            id: this.client.user.id,
            avatar: this.client.user.displayAvatarURL(),
            guilds: this.client.guilds.cache.size,
            users: this.client.users.cache.size
        };
    }

    getClient() {
        return this.client;
    }
}

module.exports = DiscordBot;