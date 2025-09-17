// Globals Imports
const { Client, GatewayIntentBits, EmbedBuilder } = require('discord.js');

// Specific Imports
const BridgeLocator = require("../bridgeLocator.js");
const WebhookManager = require("./WebhookManager.js");
const DiscordBridge = require("./DiscordBridge.js");
const logger = require("../shared/logger");

class DiscordManager {
    constructor() {
        const mainBridge = BridgeLocator.getInstance();
        this.config = mainBridge.config;

        this.client = null;
        this.webhookManager = null;
        this.discordBridge = null;
        
        this.isInitialized = false;
        this.isConnected = false;
        this.isReady = false;
        
        // Discord configuration from settings
        this.discordConfig = {
            token: this.config.get('app.token'),
            clientId: this.config.get('app.clientId'),
            serverId: this.config.get('app.serverDiscordId')
        };
        
        // Bridge configuration
        this.bridgeConfig = this.config.get('bridge');
        
        // Statistics
        this.stats = {
            messagesPosted: 0,
            webhooksUsed: 0,
            errors: 0,
            reconnections: 0,
            startTime: Date.now()
        };
    }

    async initialize() {
        if (this.isInitialized) {
            logger.warn("DiscordManager already initialized");
            return;
        }

        try {
            logger.discord("Initializing Discord module...");

            // Validate configuration
            this.validateConfiguration();

            // Create Discord client
            this.createClient();

            // Initialize webhook manager
            this.webhookManager = new WebhookManager(this.bridgeConfig);

            // Initialize Discord bridge
            this.discordBridge = new DiscordBridge(this.webhookManager);

            this.isInitialized = true;
            logger.discord("✅ Discord module initialized");

        } catch (error) {
            logger.logError(error, 'Failed to initialize Discord module');
            throw error;
        }
    }

    validateConfiguration() {
        if (!this.discordConfig.token) {
            throw new Error('Discord bot token not configured');
        }

        if (!this.discordConfig.serverId) {
            throw new Error('Discord server ID not configured');
        }

        if (!this.bridgeConfig.channels?.chat?.id) {
            throw new Error('Discord chat channel ID not configured');
        }

        logger.debug('Discord configuration validated');
    }

    createClient() {
        this.client = new Client({
            intents: [
                GatewayIntentBits.Guilds,
                GatewayIntentBits.GuildMessages,
                GatewayIntentBits.MessageContent
            ]
        });

        this.setupEventHandlers();
    }

    setupEventHandlers() {
        // Ready event
        this.client.once('ready', () => {
            this.isConnected = true;
            this.isReady = true;
            
            logger.discord(`✅ Discord bot logged in as ${this.client.user.tag}`);
            logger.discord(`Connected to Discord server: ${this.client.guilds.cache.get(this.discordConfig.serverId)?.name || 'Unknown'}`);
            
            // Initialize webhook manager with client
            if (this.webhookManager) {
                this.webhookManager.setClient(this.client);
            }

            // Start Discord bridge
            if (this.discordBridge) {
                this.discordBridge.initialize();
            }
        });

        // Error handling
        this.client.on('error', (error) => {
            logger.logError(error, 'Discord client error');
            this.stats.errors++;
        });

        // Reconnection handling
        this.client.on('disconnect', () => {
            this.isConnected = false;
            this.isReady = false;
            logger.discord('🔴 Discord client disconnected');
        });

        this.client.on('reconnecting', () => {
            logger.discord('🔄 Discord client reconnecting...');
            this.stats.reconnections++;
        });

        // Rate limit warnings
        this.client.on('rateLimit', (rateLimitData) => {
            logger.warn(`Discord rate limit hit: ${rateLimitData.method} ${rateLimitData.url} - ${rateLimitData.timeout}ms timeout`);
        });

        // Debug events (only in debug mode)
        if (this.config.get('features.logging.level') === 'debug') {
            this.client.on('debug', (info) => {
                if (info.includes('heartbeat') || info.includes('Sending a heartbeat')) {
                    return; // Skip heartbeat debug messages
                }
                logger.debug(`[Discord] ${info}`);
            });
        }
    }

    async start() {
        if (!this.isInitialized) {
            throw new Error('DiscordManager must be initialized before starting');
        }

        if (this.isConnected) {
            logger.warn('Discord client already connected');
            return;
        }

        try {
            logger.discord('Connecting to Discord...');
            
            await this.client.login(this.discordConfig.token);
            
            // Wait for ready event
            await this.waitForReady();
            
            logger.discord('✅ Discord connection established');
            
        } catch (error) {
            logger.logError(error, 'Failed to start Discord connection');
            throw error;
        }
    }

    async waitForReady(timeout = 30000) {
        return new Promise((resolve, reject) => {
            if (this.isReady) {
                resolve();
                return;
            }

            const timer = setTimeout(() => {
                reject(new Error('Discord ready timeout'));
            }, timeout);

            const onReady = () => {
                clearTimeout(timer);
                resolve();
            };

            this.client.once('ready', onReady);
        });
    }

    async stop() {
        try {
            logger.discord('Stopping Discord connection...');

            // Stop Discord bridge
            if (this.discordBridge) {
                this.discordBridge.stop();
            }

            // Stop webhook manager
            if (this.webhookManager) {
                this.webhookManager.stop();
            }

            // Destroy Discord client
            if (this.client) {
                this.client.destroy();
                this.client = null;
            }

            this.isConnected = false;
            this.isReady = false;
            
            logger.discord('✅ Discord connection stopped');

        } catch (error) {
            logger.logError(error, 'Error stopping Discord connection');
            throw error;
        }
    }

    // Public methods for sending messages/embeds
    async sendMessage(channelId, content, options = {}) {
        if (!this.isReady || !this.client) {
            throw new Error('Discord client not ready');
        }

        try {
            const channel = await this.client.channels.fetch(channelId);
            
            if (!channel) {
                throw new Error(`Channel ${channelId} not found`);
            }

            const message = await channel.send({
                content: content,
                ...options
            });

            this.stats.messagesPosted++;
            return message;

        } catch (error) {
            logger.logError(error, `Failed to send Discord message to channel ${channelId}`);
            this.stats.errors++;
            throw error;
        }
    }

    async sendEmbed(channelId, embed, options = {}) {
        if (!this.isReady || !this.client) {
            throw new Error('Discord client not ready');
        }

        try {
            const channel = await this.client.channels.fetch(channelId);
            
            if (!channel) {
                throw new Error(`Channel ${channelId} not found`);
            }

            const message = await channel.send({
                embeds: [embed],
                ...options
            });

            this.stats.messagesPosted++;
            return message;

        } catch (error) {
            logger.logError(error, `Failed to send Discord embed to channel ${channelId}`);
            this.stats.errors++;
            throw error;
        }
    }

    // Status and utility methods
    getStatus() {
        return {
            initialized: this.isInitialized,
            connected: this.isConnected,
            ready: this.isReady,
            user: this.client?.user ? {
                id: this.client.user.id,
                username: this.client.user.username,
                tag: this.client.user.tag
            } : null,
            guilds: this.client?.guilds.cache.size || 0,
            uptime: this.isConnected ? Date.now() - this.stats.startTime : 0
        };
    }

    getStatistics() {
        return {
            ...this.stats,
            uptime: this.isConnected ? Date.now() - this.stats.startTime : 0,
            webhookStats: this.webhookManager ? this.webhookManager.getStatistics() : null,
            bridgeStats: this.discordBridge ? this.discordBridge.getStatistics() : null
        };
    }

    isDiscordReady() {
        return this.isReady;
    }

    getClient() {
        return this.client;
    }

    getWebhookManager() {
        return this.webhookManager;
    }

    getDiscordBridge() {
        return this.discordBridge;
    }

    // Configuration methods
    getChannelConfig(channelType = 'chat') {
        return this.bridgeConfig.channels?.[channelType];
    }

    getWebhookConfig() {
        return this.bridgeConfig.webhook;
    }

    getBridgeConfig() {
        return this.bridgeConfig;
    }

    // Utility method to create embeds
    createEmbed(title, description, color = 0x00AE86) {
        return new EmbedBuilder()
            .setTitle(title)
            .setDescription(description)
            .setColor(color)
            .setTimestamp();
    }

    // Method to get guild channels
    async getGuildChannels() {
        if (!this.isReady || !this.client) {
            return [];
        }

        try {
            const guild = await this.client.guilds.fetch(this.discordConfig.serverId);
            const channels = await guild.channels.fetch();
            
            return channels
                .filter(channel => channel.isTextBased())
                .map(channel => ({
                    id: channel.id,
                    name: channel.name,
                    type: channel.type
                }));

        } catch (error) {
            logger.logError(error, 'Failed to get guild channels');
            return [];
        }
    }

    // Health check method
    async healthCheck() {
        const status = {
            healthy: true,
            issues: []
        };

        if (!this.isInitialized) {
            status.healthy = false;
            status.issues.push('Discord manager not initialized');
        }

        if (!this.isConnected) {
            status.healthy = false;
            status.issues.push('Discord client not connected');
        }

        if (!this.isReady) {
            status.healthy = false;
            status.issues.push('Discord client not ready');
        }

        if (this.webhookManager) {
            const webhookHealth = await this.webhookManager.healthCheck();
            if (!webhookHealth.healthy) {
                status.healthy = false;
                status.issues.push(...webhookHealth.issues.map(issue => `Webhook: ${issue}`));
            }
        }

        if (this.stats.errors > 10) {
            status.issues.push(`High error count: ${this.stats.errors}`);
        }

        return status;
    }
}

module.exports = DiscordManager;