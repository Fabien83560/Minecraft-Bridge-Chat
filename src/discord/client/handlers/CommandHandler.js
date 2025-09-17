// Globals Imports
const { EmbedBuilder: DiscordEmbedBuilder, PermissionsBitField } = require('discord.js');
const EventEmitter = require('events');

// Specific Imports
const BridgeLocator = require("../../../bridgeLocator.js");
const logger = require("../../../shared/logger");

class CommandHandler extends EventEmitter {
    constructor() {
        super();

        const mainBridge = BridgeLocator.getInstance();
        this.config = mainBridge.config;

        this.client = null;
        this.commands = new Map();
        
        // Command configuration
        this.commandPrefix = this.config.get('bridge.commandPrefix') || '!';
        this.adminRoles = this.config.get('bridge.adminRoles') || [];
        this.modRoles = this.config.get('bridge.modRoles') || [];
        
        // Statistics
        this.stats = {
            commandsProcessed: 0,
            invalidCommands: 0,
            unauthorizedAttempts: 0,
            errors: 0
        };

        // Initialize commands
        this.initializeCommands();
    }

    /**
     * Initialize with Discord client
     * @param {Client} client - Discord client instance
     */
    async initialize(client) {
        if (!client) {
            throw new Error('Discord client is required for CommandHandler initialization');
        }

        this.client = client;

        try {
            logger.discord('CommandHandler initialized with Discord client');

        } catch (error) {
            logger.logError(error, 'Failed to initialize CommandHandler with client');
            throw error;
        }
    }

    /**
     * Initialize available commands
     */
    initializeCommands() {
        // Basic bridge commands
        this.registerCommand('status', {
            description: 'Show bridge status',
            usage: `${this.commandPrefix}status`,
            permission: 'user',
            handler: this.handleStatusCommand.bind(this)
        });

        this.registerCommand('help', {
            description: 'Show available commands',
            usage: `${this.commandPrefix}help [command]`,
            permission: 'user',
            handler: this.handleHelpCommand.bind(this)
        });

        this.registerCommand('stats', {
            description: 'Show detailed statistics',
            usage: `${this.commandPrefix}stats`,
            permission: 'mod',
            handler: this.handleStatsCommand.bind(this)
        });

        this.registerCommand('reload', {
            description: 'Reload bridge configuration',
            usage: `${this.commandPrefix}reload`,
            permission: 'admin',
            handler: this.handleReloadCommand.bind(this)
        });

        this.registerCommand('test', {
            description: 'Send test message to verify bridge functionality',
            usage: `${this.commandPrefix}test`,
            permission: 'mod',
            handler: this.handleTestCommand.bind(this)
        });

        logger.debug(`CommandHandler initialized with ${this.commands.size} commands`);
    }

    /**
     * Register a command
     * @param {string} name - Command name
     * @param {object} commandConfig - Command configuration
     */
    registerCommand(name, commandConfig) {
        this.commands.set(name.toLowerCase(), {
            name: name.toLowerCase(),
            ...commandConfig
        });
    }

    /**
     * Process a command message
     * @param {Message} message - Discord message object
     * @param {string} commandString - Command string without prefix
     */
    async processCommand(message, commandString) {
        try {
            this.stats.commandsProcessed++;

            const args = commandString.split(' ');
            const commandName = args[0].toLowerCase();
            const commandArgs = args.slice(1);

            const command = this.commands.get(commandName);

            if (!command) {
                this.stats.invalidCommands++;
                await this.sendErrorMessage(message, `Unknown command: ${commandName}. Use \`${this.commandPrefix}help\` for available commands.`);
                return;
            }

            // Check permissions
            if (!this.hasPermission(message.member, command.permission)) {
                this.stats.unauthorizedAttempts++;
                await this.sendErrorMessage(message, 'You do not have permission to use this command.');
                return;
            }

            // Execute command
            await command.handler(message, commandArgs);

            logger.discord(`[DISCORD] Command executed: ${commandName} by ${message.author.displayName}`);

        } catch (error) {
            this.stats.errors++;
            logger.logError(error, `Error processing command: ${commandString}`);
            await this.sendErrorMessage(message, 'An error occurred while processing the command.');
        }
    }

    // ==================== COMMAND HANDLERS ====================

    /**
     * Handle status command
     * @param {Message} message - Discord message
     * @param {Array} args - Command arguments
     */
    async handleStatusCommand(message, args) {
        try {
            const mainBridge = BridgeLocator.getInstance();
            
            // Get status information
            const discordStatus = mainBridge.getDiscordManager?.()?.getConnectionStatus() || { connected: false };
            const minecraftStatus = mainBridge.getMinecraftManager?.()?.getConnectionStatus() || { connected: false };
            
            const embed = new DiscordEmbedBuilder()
                .setTitle('🌉 Bridge Status')
                .setColor(discordStatus.connected && minecraftStatus.connections?.length > 0 ? 0x00FF00 : 0xFFFF00)
                .setTimestamp();

            // Discord status
            embed.addFields({
                name: '💬 Discord',
                value: discordStatus.connected ? '✅ Connected' : '❌ Disconnected',
                inline: true
            });

            // Minecraft status
            const mcConnections = minecraftStatus.connections?.length || 0;
            embed.addFields({
                name: '🎮 Minecraft',
                value: mcConnections > 0 ? `✅ ${mcConnections} connections` : '❌ No connections',
                inline: true
            });

            // Uptime
            const uptime = process.uptime();
            const uptimeStr = this.formatUptime(uptime);
            embed.addFields({
                name: '⏰ Uptime',
                value: uptimeStr,
                inline: true
            });

            await message.reply({ embeds: [embed] });

        } catch (error) {
            logger.logError(error, 'Error handling status command');
            await this.sendErrorMessage(message, 'Failed to get status information.');
        }
    }

    /**
     * Handle help command
     * @param {Message} message - Discord message
     * @param {Array} args - Command arguments
     */
    async handleHelpCommand(message, args) {
        try {
            if (args.length > 0) {
                // Show help for specific command
                const commandName = args[0].toLowerCase();
                const command = this.commands.get(commandName);

                if (!command) {
                    await this.sendErrorMessage(message, `Command not found: ${commandName}`);
                    return;
                }

                const embed = new DiscordEmbedBuilder()
                    .setTitle(`📖 Help: ${command.name}`)
                    .setDescription(command.description)
                    .addFields(
                        { name: 'Usage', value: `\`${command.usage}\``, inline: false },
                        { name: 'Permission', value: command.permission, inline: true }
                    )
                    .setColor(0x0099FF)
                    .setTimestamp();

                await message.reply({ embeds: [embed] });

            } else {
                // Show all available commands
                const userCommands = [];
                const modCommands = [];
                const adminCommands = [];

                for (const [name, command] of this.commands) {
                    const commandInfo = `\`${command.name}\` - ${command.description}`;
                    
                    switch (command.permission) {
                        case 'admin':
                            adminCommands.push(commandInfo);
                            break;
                        case 'mod':
                            modCommands.push(commandInfo);
                            break;
                        default:
                            userCommands.push(commandInfo);
                    }
                }

                const embed = new DiscordEmbedBuilder()
                    .setTitle('📖 Available Commands')
                    .setDescription(`Use \`${this.commandPrefix}help <command>\` for detailed information about a specific command.`)
                    .setColor(0x0099FF)
                    .setTimestamp();

                if (userCommands.length > 0) {
                    embed.addFields({ name: '👤 User Commands', value: userCommands.join('\n'), inline: false });
                }

                if (modCommands.length > 0 && this.hasPermission(message.member, 'mod')) {
                    embed.addFields({ name: '🛡️ Moderator Commands', value: modCommands.join('\n'), inline: false });
                }

                if (adminCommands.length > 0 && this.hasPermission(message.member, 'admin')) {
                    embed.addFields({ name: '👑 Admin Commands', value: adminCommands.join('\n'), inline: false });
                }

                await message.reply({ embeds: [embed] });
            }

        } catch (error) {
            logger.logError(error, 'Error handling help command');
            await this.sendErrorMessage(message, 'Failed to show help information.');
        }
    }

    /**
     * Handle stats command
     * @param {Message} message - Discord message
     * @param {Array} args - Command arguments
     */
    async handleStatsCommand(message, args) {
        try {
            const mainBridge = BridgeLocator.getInstance();
            
            // Get statistics from all managers
            const discordStats = mainBridge.getDiscordManager?.()?.getStatistics() || {};
            const minecraftStats = mainBridge.getMinecraftManager?.()?.getStatistics() || {};

            const embed = new DiscordEmbedBuilder()
                .setTitle('📊 Bridge Statistics')
                .setColor(0x0099FF)
                .setTimestamp();

            // Command stats
            embed.addFields({
                name: '🎯 Commands',
                value: `Processed: ${this.stats.commandsProcessed}\nInvalid: ${this.stats.invalidCommands}\nUnauthorized: ${this.stats.unauthorizedAttempts}`,
                inline: true
            });

            // Discord stats
            if (discordStats.messageSender) {
                embed.addFields({
                    name: '💬 Discord Messages',
                    value: `Sent: ${discordStats.messageSender.messagesSent}\nEvents: ${discordStats.messageSender.eventsSent}\nErrors: ${discordStats.messageSender.errors}`,
                    inline: true
                });
            }

            // Minecraft stats
            if (minecraftStats.totalMessages) {
                embed.addFields({
                    name: '🎮 Minecraft Messages',
                    value: `Total: ${minecraftStats.totalMessages}\nGuild: ${minecraftStats.guildMessages || 0}\nEvents: ${minecraftStats.events || 0}`,
                    inline: true
                });
            }

            await message.reply({ embeds: [embed] });

        } catch (error) {
            logger.logError(error, 'Error handling stats command');
            await this.sendErrorMessage(message, 'Failed to get statistics.');
        }
    }

    /**
     * Handle reload command
     * @param {Message} message - Discord message
     * @param {Array} args - Command arguments
     */
    async handleReloadCommand(message, args) {
        try {
            await message.reply('⚠️ Configuration reload is not implemented yet. Please restart the bridge manually.');

        } catch (error) {
            logger.logError(error, 'Error handling reload command');
            await this.sendErrorMessage(message, 'Failed to reload configuration.');
        }
    }

    /**
     * Handle test command
     * @param {Message} message - Discord message
     * @param {Array} args - Command arguments
     */
    async handleTestCommand(message, args) {
        try {
            const mainBridge = BridgeLocator.getInstance();
            const discordManager = mainBridge.getDiscordManager?.();

            if (!discordManager) {
                await this.sendErrorMessage(message, 'Discord manager not available.');
                return;
            }

            const testResult = await discordManager.testMessageSending({
                username: message.author.displayName,
                message: 'Test message from Discord command',
                chatType: 'guild',
                type: 'test'
            });

            if (testResult.success) {
                await message.reply('✅ Test message sent successfully!');
            } else {
                await this.sendErrorMessage(message, `Test failed: ${testResult.error}`);
            }

        } catch (error) {
            logger.logError(error, 'Error handling test command');
            await this.sendErrorMessage(message, 'Failed to send test message.');
        }
    }

    // ==================== UTILITY METHODS ====================

    /**
     * Check if user has required permission
     * @param {GuildMember} member - Discord guild member
     * @param {string} requiredPermission - Required permission level
     * @returns {boolean} Whether user has permission
     */
    hasPermission(member, requiredPermission) {
        if (!member) return false;

        switch (requiredPermission) {
            case 'user':
                return true; // Everyone can use user commands

            case 'mod':
                // Check for moderator roles or admin permissions
                return member.permissions.has(PermissionsBitField.Flags.ManageMessages) ||
                       this.modRoles.some(roleId => member.roles.cache.has(roleId)) ||
                       this.adminRoles.some(roleId => member.roles.cache.has(roleId));

            case 'admin':
                // Check for admin roles or admin permissions
                return member.permissions.has(PermissionsBitField.Flags.Administrator) ||
                       this.adminRoles.some(roleId => member.roles.cache.has(roleId));

            default:
                return false;
        }
    }

    /**
     * Send error message
     * @param {Message} message - Original message
     * @param {string} errorText - Error message text
     */
    async sendErrorMessage(message, errorText) {
        try {
            const embed = new DiscordEmbedBuilder()
                .setColor(0xFF0000)
                .setTitle('❌ Error')
                .setDescription(errorText)
                .setTimestamp();

            await message.reply({ embeds: [embed] });

        } catch (error) {
            logger.logError(error, 'Failed to send error message');
            // Fallback to simple text message
            try {
                await message.reply(`❌ ${errorText}`);
            } catch (fallbackError) {
                logger.logError(fallbackError, 'Failed to send fallback error message');
            }
        }
    }

    /**
     * Format uptime duration
     * @param {number} seconds - Uptime in seconds
     * @returns {string} Formatted uptime string
     */
    formatUptime(seconds) {
        const days = Math.floor(seconds / 86400);
        const hours = Math.floor((seconds % 86400) / 3600);
        const minutes = Math.floor((seconds % 3600) / 60);

        const parts = [];
        if (days > 0) parts.push(`${days}d`);
        if (hours > 0) parts.push(`${hours}h`);
        if (minutes > 0) parts.push(`${minutes}m`);
        
        return parts.length > 0 ? parts.join(' ') : '< 1m';
    }

    /**
     * Get statistics
     * @returns {object} Handler statistics
     */
    getStatistics() {
        return {
            ...this.stats,
            commandsRegistered: this.commands.size,
            prefix: this.commandPrefix,
            clientReady: !!this.client
        };
    }

    /**
     * Update configuration
     * @param {object} newConfig - New configuration
     */
    updateConfig(newConfig) {
        if (newConfig.commandPrefix !== undefined) {
            this.commandPrefix = newConfig.commandPrefix;
        }

        if (newConfig.adminRoles) {
            this.adminRoles = newConfig.adminRoles;
        }

        if (newConfig.modRoles) {
            this.modRoles = newConfig.modRoles;
        }

        logger.debug('CommandHandler configuration updated');
    }

    /**
     * Cleanup resources
     */
    cleanup() {
        this.client = null;
        
        // Remove all listeners
        this.removeAllListeners();

        logger.debug('CommandHandler cleaned up');
    }
}

module.exports = CommandHandler;