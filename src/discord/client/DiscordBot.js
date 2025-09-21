// Globals Imports
const { Client, GatewayIntentBits, ActivityType } = require('discord.js');
const EventEmitter = require('events');

// Specific Imports
const BridgeLocator = require("../../bridgeLocator.js");
const MessageHandler = require("./handlers/MessageHandler.js");
const CommandHandler = require("./handlers/CommandHandler.js");
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
        this.commandHandler = null;
        this.slashCommandHandler = null;

        // Statistics
        this.stats = {
            startTime: null,
            messagesReceived: 0,
            messagesSent: 0,
            commandsProcessed: 0,
            slashCommandsProcessed: 0,
            errors: 0,
            reconnections: 0
        };

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
            this.commandHandler = new CommandHandler();
            this.slashCommandHandler = new SlashCommandHandler();

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
            this.stats.errors++;
            logger.logError(error, 'Discord bot error');
            
            this.emit('error', error);
        });

        // Warning event
        this.client.on('warn', (warning) => {
            logger.warn(`Discord bot warning: ${warning}`);
        });

        // Message event - handle both regular messages and commands
        this.client.on('messageCreate', async (message) => {
            this.stats.messagesReceived++;
            
            if (!this._isReady) return;

            // Check if message is a command
            const commandPrefix = this.config.get('bridge.commandPrefix') || '!';
            
            if (message.content.startsWith(commandPrefix)) {
                // Handle command
                if (this.commandHandler) {
                    const commandString = message.content.substring(commandPrefix.length).trim();
                    await this.commandHandler.processCommand(message, commandString);
                    this.stats.commandsProcessed++;
                }
            } else {
                // Handle regular message
                if (this.messageHandler) {
                    await this.messageHandler.handleMessage(message);
                }
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

            // Initialize command handler
            if (this.commandHandler) {
                await this.commandHandler.initialize(this.client);
                logger.debug('Command handler initialized');
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

            this.stats.startTime = Date.now();

            // Login to Discord
            await this.client.login(token);

            // Wait for ready event
            await this.waitForReady();

            logger.discord('✅ Discord bot started successfully');

        } catch (error) {
            this.stats.errors++;
            logger.logError(error, 'Failed to start Discord bot');

            if (this.connectionAttempts < this.maxConnectionAttempts) {
                this.scheduleReconnection();
            }

            throw error;
        }
    }

    async waitForReady() {
        return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                reject(new Error('Discord bot ready timeout'));
            }, 30000); // 30 second timeout

            const onReady = () => {
                clearTimeout(timeout);
                this.client.off('error', onError);
                resolve();
            };

            const onError = (error) => {
                clearTimeout(timeout);
                this.client.off('ready', onReady);
                reject(error);
            };

            if (this._isReady) {
                clearTimeout(timeout);
                resolve();
                return;
            }

            this.client.once('ready', onReady);
            this.client.once('error', onError);
        });
    }

    scheduleReconnection() {
        if (this.reconnectTimeout) {
            clearTimeout(this.reconnectTimeout);
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
            if (this.commandHandler) {
                this.commandHandler.cleanup();
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

    isConnected() {
        return this._isConnected;
    }

    isReady() {
        return this._isReady;
    }

    getClient() {
        return this.client;
    }

    getConnectionStatus() {
        return {
            connected: this._isConnected,
            ready: this._isReady,
            connectionAttempts: this.connectionAttempts,
            guilds: this.client ? this.client.guilds.cache.size : 0,
            ping: this.client ? this.client.ws.ping : null
        };
    }

    /**
     * Reload slash commands
     */
    async reloadSlashCommands() {
        if (!this.slashCommandHandler) {
            throw new Error('SlashCommandHandler not available');
        }

        try {
            const result = await this.slashCommandHandler.reloadCommands();
            logger.discord(`Slash commands reloaded: ${result.success ? 'success' : 'failed'}`);
            return result;
        } catch (error) {
            logger.logError(error, 'Failed to reload slash commands');
            throw error;
        }
    }

    getStatistics() {
        const uptime = this.stats.startTime ? 
            Date.now() - this.stats.startTime : 0;

        return {
            ...this.stats,
            uptime: uptime,
            connected: this._isConnected,
            ready: this._isReady,
            connectionAttempts: this.connectionAttempts,
            guilds: this.client ? this.client.guilds.cache.size : 0,
            users: this.client ? this.client.users.cache.size : 0,
            channels: this.client ? this.client.channels.cache.size : 0,
            ping: this.client ? this.client.ws.ping : null,
            handlers: {
                messageHandler: !!this.messageHandler,
                commandHandler: !!this.commandHandler,
                slashCommandHandler: !!this.slashCommandHandler
            }
        };
    }

    // ==================== EVENT FORWARDING METHODS ====================

    onMessage(callback) {
        this.on('message', callback);
    }

    onCommand(callback) {
        this.on('command', callback);
    }

    onSlashCommand(callback) {
        this.on('slashCommand', callback);
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