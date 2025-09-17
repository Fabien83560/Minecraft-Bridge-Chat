// Globals Imports
const { Client, GatewayIntentBits, ActivityType } = require('discord.js');
const EventEmitter = require('events');

// Specific Imports
const BridgeLocator = require("../../bridgeLocator.js");
const MessageHandler = require("./handlers/MessageHandler.js");
const CommandHandler = require("./handlers/CommandHandler.js");
const logger = require("../../shared/logger");

class DiscordBot extends EventEmitter {
    constructor() {
        super();

        const mainBridge = BridgeLocator.getInstance();
        this.config = mainBridge.config;

        this.client = null;
        this.isConnected = false;
        this.isReady = false;
        this.connectionAttempts = 0;
        this.maxConnectionAttempts = 5;
        this.reconnectTimeout = null;

        // Handlers
        this.messageHandler = null;
        this.commandHandler = null;

        // Statistics
        this.stats = {
            startTime: null,
            messagesReceived: 0,
            messagesSent: 0,
            commandsProcessed: 0,
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

            // Initialize handlers
            this.messageHandler = new MessageHandler();
            this.commandHandler = new CommandHandler();

            this.setupEventHandlers();
            
            logger.discord('Discord client initialized with intents');

        } catch (error) {
            logger.logError(error, 'Failed to initialize Discord client');
            throw error;
        }
    }

    async start() {
        if (this.isConnected) {
            logger.warn('Discord bot is already connected');
            return;
        }

        try {
            this.connectionAttempts++;
            this.stats.startTime = Date.now();

            logger.discord(`Starting Discord bot (attempt ${this.connectionAttempts}/${this.maxConnectionAttempts})`);

            const token = this.config.get('app.token');
            if (!token) {
                throw new Error('Discord bot token not found in configuration');
            }

            await this.client.login(token);

            // Wait for ready event
            await this.waitForReady();

            this.connectionAttempts = 0; // Reset on successful connection
            logger.discord('✅ Discord bot started successfully');

        } catch (error) {
            logger.logError(error, `Discord bot start failed (attempt ${this.connectionAttempts})`);
            
            if (this.connectionAttempts >= this.maxConnectionAttempts) {
                logger.discord(`❌ Max connection attempts reached for Discord bot`);
                throw new Error(`Max Discord connection attempts (${this.maxConnectionAttempts}) reached`);
            }

            // Schedule reconnection
            this.scheduleReconnection();
            throw error;
        }
    }

    async waitForReady() {
        return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                reject(new Error('Discord bot ready timeout after 30 seconds'));
            }, 30000);

            if (this.isReady) {
                clearTimeout(timeout);
                resolve();
                return;
            }

            this.client.once('ready', () => {
                clearTimeout(timeout);
                resolve();
            });

            this.client.once('error', (error) => {
                clearTimeout(timeout);
                reject(error);
            });
        });
    }

    setupEventHandlers() {
        // Ready event
        this.client.on('ready', () => {
            this.isConnected = true;
            this.isReady = true;
            
            const botInfo = {
                username: this.client.user.username,
                id: this.client.user.id,
                discriminator: this.client.user.discriminator,
                tag: this.client.user.tag
            };

            logger.discord(`✅ Discord bot logged in as ${botInfo.tag}`);

            // Set bot activity/status
            this.setBotActivity();

            // Emit connection event
            this.emit('connection', {
                type: 'connected',
                bot: botInfo,
                guilds: this.client.guilds.cache.size,
                users: this.client.users.cache.size
            });
        });

        // Disconnect event
        this.client.on('disconnect', () => {
            this.isConnected = false;
            this.isReady = false;
            
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

        // Debug event (only in debug mode)
        if (this.config.get('features.logging.level') === 'debug') {
            this.client.on('debug', (info) => {
                logger.debug(`Discord: ${info}`);
            });
        }

        // Rate limit event
        this.client.on('rateLimit', (info) => {
            logger.warn(`Discord rate limit hit: ${JSON.stringify(info)}`);
        });

        // Message event
        this.client.on('messageCreate', async (message) => {
            try {
                this.stats.messagesReceived++;
                await this.handleMessage(message);
            } catch (error) {
                logger.logError(error, 'Error handling Discord message');
            }
        });

        // Guild events
        this.client.on('guildCreate', (guild) => {
            logger.discord(`Joined Discord guild: ${guild.name} (${guild.id})`);
        });

        this.client.on('guildDelete', (guild) => {
            logger.discord(`Left Discord guild: ${guild.name} (${guild.id})`);
        });
    }

    async handleMessage(message) {
        // Ignore bot messages
        if (message.author.bot) return;

        const bridgeConfig = this.config.get('bridge');
        const chatChannelId = bridgeConfig.channels.chat.id;
        const staffChannelId = bridgeConfig.channels.staff.id;

        // Check if message is in a bridge channel
        if (message.channel.id === chatChannelId || message.channel.id === staffChannelId) {
            // Handle bridge channel message
            const messageData = await this.messageHandler.handleBridgeMessage(message);
            if (messageData) {
                this.emit('message', {
                    type: 'bridge_message',
                    data: messageData,
                    channel: message.channel.id === chatChannelId ? 'chat' : 'staff'
                });
            }
        }

        // Check for commands
        const commandResult = await this.commandHandler.handleCommand(message);
        if (commandResult) {
            this.stats.commandsProcessed++;
            this.emit('command', commandResult);
        }
    }

    setBotActivity() {
        try {
            const enabledGuilds = this.config.getEnabledGuilds();
            const guildCount = enabledGuilds.length;
            
            this.client.user.setActivity(`${guildCount} Minecraft guilds`, {
                type: ActivityType.Watching
            });

            this.client.user.setStatus('online');
            
            logger.debug(`Discord bot activity set: Watching ${guildCount} Minecraft guilds`);

        } catch (error) {
            logger.logError(error, 'Failed to set Discord bot activity');
        }
    }

    scheduleReconnection() {
        if (this.reconnectTimeout) {
            clearTimeout(this.reconnectTimeout);
        }

        const delay = Math.min(5000 * this.connectionAttempts, 60000); // Max 1 minute delay
        
        logger.discord(`Scheduling Discord reconnection in ${delay}ms`);

        this.reconnectTimeout = setTimeout(async () => {
            try {
                this.stats.reconnections++;
                await this.start();
            } catch (error) {
                logger.logError(error, 'Discord reconnection failed');
            }
        }, delay);
    }

    async stop() {
        try {
            if (this.reconnectTimeout) {
                clearTimeout(this.reconnectTimeout);
                this.reconnectTimeout = null;
            }

            if (this.client && this.isConnected) {
                logger.discord('Stopping Discord bot...');
                
                // Set offline status before destroying
                if (this.client.user) {
                    await this.client.user.setStatus('invisible');
                }

                this.client.destroy();
            }

            this.isConnected = false;
            this.isReady = false;

            logger.discord('✅ Discord bot stopped');

        } catch (error) {
            logger.logError(error, 'Error stopping Discord bot');
            throw error;
        }
    }

    // ==================== GETTER METHODS ====================

    getClient() {
        return this.client;
    }

    isConnected() {
        return this.isConnected && this.isReady;
    }

    getConnectionStatus() {
        return {
            connected: this.isConnected,
            ready: this.isReady,
            connectionAttempts: this.connectionAttempts,
            uptime: this.stats.startTime ? Date.now() - this.stats.startTime : 0
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
            guilds: this.client.guilds.cache.size,
            users: this.client.users.cache.size,
            channels: this.client.channels.cache.size
        };
    }

    getStatistics() {
        const uptime = this.stats.startTime ? Date.now() - this.stats.startTime : 0;
        
        return {
            ...this.stats,
            uptime: uptime,
            connected: this.isConnected,
            ready: this.isReady,
            connectionAttempts: this.connectionAttempts,
            ping: this.client ? this.client.ws.ping : -1
        };
    }

    // ==================== UTILITY METHODS ====================

    /**
     * Get Discord channel by ID
     * @param {string} channelId - Channel ID
     * @returns {Channel|null} Discord channel or null
     */
    getChannel(channelId) {
        if (!this.client) return null;
        
        try {
            return this.client.channels.cache.get(channelId);
        } catch (error) {
            logger.logError(error, `Failed to get Discord channel: ${channelId}`);
            return null;
        }
    }

    /**
     * Get Discord guild by ID
     * @param {string} guildId - Guild ID
     * @returns {Guild|null} Discord guild or null
     */
    getGuild(guildId) {
        if (!this.client) return null;
        
        try {
            return this.client.guilds.cache.get(guildId);
        } catch (error) {
            logger.logError(error, `Failed to get Discord guild: ${guildId}`);
            return null;
        }
    }

    /**
     * Update bot activity
     * @param {string} activity - Activity text
     * @param {string} type - Activity type
     */
    async updateActivity(activity, type = 'WATCHING') {
        if (!this.client || !this.client.user) return;

        try {
            await this.client.user.setActivity(activity, { type: ActivityType[type] });
            logger.debug(`Discord bot activity updated: ${type} ${activity}`);
        } catch (error) {
            logger.logError(error, 'Failed to update Discord bot activity');
        }
    }

    /**
     * Update bot status
     * @param {string} status - Status (online, idle, dnd, invisible)
     */
    async updateStatus(status) {
        if (!this.client || !this.client.user) return;

        try {
            await this.client.user.setStatus(status);
            logger.debug(`Discord bot status updated: ${status}`);
        } catch (error) {
            logger.logError(error, 'Failed to update Discord bot status');
        }
    }

    // ==================== EVENT FORWARDING ====================

    onMessage(callback) {
        this.on('message', callback);
    }

    onConnection(callback) {
        this.on('connection', callback);
    }

    onError(callback) {
        this.on('error', callback);
    }

    onCommand(callback) {
        this.on('command', callback);
    }
}

module.exports = DiscordBot;