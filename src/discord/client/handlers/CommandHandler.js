// Specific Imports
const BridgeLocator = require("../../../bridgeLocator.js");
const AdminCommands = require("../../../shared/AdminCommands.js");
const EmbedBuilder = require("../../utils/EmbedBuilder.js");
const logger = require("../../../shared/logger");

class CommandHandler {
    constructor() {
        const mainBridge = BridgeLocator.getInstance();
        this.config = mainBridge.config;

        this.embedBuilder = new EmbedBuilder();
        this.adminCommands = new AdminCommands();

        // Command configuration
        this.prefix = '!bridge'; // Default command prefix
        this.allowedChannels = new Set([
            this.config.get('bridge.channels.chat.id'),
            this.config.get('bridge.channels.staff.id')
        ]);

        // Command cooldowns (userId -> lastUsed timestamp)
        this.cooldowns = new Map();
        this.cooldownTime = 5000; // 5 seconds

        // Statistics
        this.stats = {
            commandsProcessed: 0,
            adminCommandsProcessed: 0,
            cooldownHits: 0,
            unauthorizedAttempts: 0,
            errors: 0
        };

        // Available commands
        this.commands = new Map([
            ['status', {
                description: 'Show system status',
                usage: '!bridge status',
                permission: 'admin',
                execute: this.handleStatusCommand.bind(this)
            }],
            ['stats', {
                description: 'Show detailed statistics',
                usage: '!bridge stats [category]',
                permission: 'admin',
                execute: this.handleStatsCommand.bind(this)
            }],
            ['health', {
                description: 'Show system health',
                usage: '!bridge health',
                permission: 'admin',
                execute: this.handleHealthCommand.bind(this)
            }],
            ['connections', {
                description: 'Show Minecraft connection status',
                usage: '!bridge connections',
                permission: 'admin',
                execute: this.handleConnectionsCommand.bind(this)
            }],
            ['interguild', {
                description: 'Manage inter-guild system',
                usage: '!bridge interguild <status|enable|disable|clear>',
                permission: 'admin',
                execute: this.handleInterGuildCommand.bind(this)
            }],
            ['test', {
                description: 'Test bot functionality',
                usage: '!bridge test [type]',
                permission: 'admin',
                execute: this.handleTestCommand.bind(this)
            }],
            ['help', {
                description: 'Show available commands',
                usage: '!bridge help [command]',
                permission: 'user',
                execute: this.handleHelpCommand.bind(this)
            }],
            ['ping', {
                description: 'Check bot responsiveness',
                usage: '!bridge ping',
                permission: 'user',
                execute: this.handlePingCommand.bind(this)
            }]
        ]);

        logger.debug('Discord CommandHandler initialized');
    }

    /**
     * Handle Discord command message
     * @param {Message} message - Discord message object
     * @returns {object|null} Command result or null
     */
    async handleCommand(message) {
        try {
            // Check if message starts with command prefix
            if (!message.content.startsWith(this.prefix)) {
                return null;
            }

            // Check if command is in allowed channel
            if (!this.allowedChannels.has(message.channel.id)) {
                return null;
            }

            // Parse command
            const args = message.content.slice(this.prefix.length).trim().split(/\s+/);
            const commandName = args.shift().toLowerCase();

            if (!commandName) {
                return null;
            }

            // Check if command exists
            const command = this.commands.get(commandName);
            if (!command) {
                await this.sendErrorMessage(message, `Unknown command: ${commandName}`, 'Use `!bridge help` for available commands');
                return null;
            }

            // Check cooldown
            if (this.isOnCooldown(message.author.id)) {
                this.stats.cooldownHits++;
                await this.sendErrorMessage(message, 'Command on cooldown', `Please wait ${Math.ceil(this.cooldownTime / 1000)} seconds between commands`);
                return null;
            }

            // Check permissions
            if (!this.hasPermission(message, command.permission)) {
                this.stats.unauthorizedAttempts++;
                await this.sendErrorMessage(message, 'Insufficient permissions', 'You do not have permission to use this command');
                return null;
            }

            logger.discord(`Processing command: ${commandName} from ${message.author.tag}`);

            // Execute command
            const result = await command.execute(message, args);

            // Update cooldown
            this.updateCooldown(message.author.id);
            this.stats.commandsProcessed++;

            if (command.permission === 'admin') {
                this.stats.adminCommandsProcessed++;
            }

            return {
                command: commandName,
                args: args,
                user: message.author.tag,
                channel: message.channel.id,
                result: result,
                success: true
            };

        } catch (error) {
            this.stats.errors++;
            logger.logError(error, `Error handling Discord command from ${message.author?.tag || 'unknown'}`);
            
            await this.sendErrorMessage(message, 'Command execution failed', error.message);
            
            return {
                command: commandName || 'unknown',
                user: message.author?.tag || 'unknown',
                error: error.message,
                success: false
            };
        }
    }

    // ==================== COMMAND IMPLEMENTATIONS ====================

    /**
     * Handle status command
     */
    async handleStatusCommand(message, args) {
        try {
            const result = await this.adminCommands.executeCommand('status');
            
            if (result.success) {
                const statusData = result.result;
                const embed = this.createStatusEmbed(statusData);
                await message.reply({ embeds: [embed] });
            } else {
                await this.sendErrorMessage(message, 'Status command failed', result.error);
            }

            return result;

        } catch (error) {
            logger.logError(error, 'Status command execution failed');
            throw error;
        }
    }

    /**
     * Handle stats command
     */
    async handleStatsCommand(message, args) {
        try {
            const category = args[0] || '';
            const commandLine = category ? `stats ${category}` : 'stats';
            const result = await this.adminCommands.executeCommand(commandLine);

            if (result.success) {
                const statsData = result.result;
                const embed = this.createStatsEmbed(statsData, category);
                await message.reply({ embeds: [embed] });
            } else {
                await this.sendErrorMessage(message, 'Stats command failed', result.error);
            }

            return result;

        } catch (error) {
            logger.logError(error, 'Stats command execution failed');
            throw error;
        }
    }

    /**
     * Handle health command
     */
    async handleHealthCommand(message, args) {
        try {
            const result = await this.adminCommands.executeCommand('health');

            if (result.success) {
                const healthData = result.result;
                const embed = this.createHealthEmbed(healthData);
                await message.reply({ embeds: [embed] });
            } else {
                await this.sendErrorMessage(message, 'Health command failed', result.error);
            }

            return result;

        } catch (error) {
            logger.logError(error, 'Health command execution failed');
            throw error;
        }
    }

    /**
     * Handle connections command
     */
    async handleConnectionsCommand(message, args) {
        try {
            const result = await this.adminCommands.executeCommand('connections');

            if (result.success) {
                const connectionData = result.result;
                const embed = this.createConnectionsEmbed(connectionData);
                await message.reply({ embeds: [embed] });
            } else {
                await this.sendErrorMessage(message, 'Connections command failed', result.error);
            }

            return result;

        } catch (error) {
            logger.logError(error, 'Connections command execution failed');
            throw error;
        }
    }

    /**
     * Handle inter-guild command
     */
    async handleInterGuildCommand(message, args) {
        try {
            const action = args[0];
            if (!action) {
                await this.sendErrorMessage(message, 'Missing action', 'Available actions: status, enable, disable, clear');
                return { success: false, error: 'Missing action' };
            }

            const commandLine = `interguild ${action}`;
            const result = await this.adminCommands.executeCommand(commandLine);

            if (result.success) {
                const embed = this.embedBuilder.createInfoEmbed(
                    '🌉 Inter-Guild Management',
                    result.result.message || JSON.stringify(result.result, null, 2),
                    'system'
                );
                await message.reply({ embeds: [embed] });
            } else {
                await this.sendErrorMessage(message, 'Inter-guild command failed', result.error);
            }

            return result;

        } catch (error) {
            logger.logError(error, 'Inter-guild command execution failed');
            throw error;
        }
    }

    /**
     * Handle test command
     */
    async handleTestCommand(message, args) {
        try {
            const testType = args[0] || 'basic';
            
            let result;
            switch (testType) {
                case 'discord':
                    result = await this.testDiscordFunctionality();
                    break;
                case 'minecraft':
                    result = await this.testMinecraftConnections();
                    break;
                case 'interguild':
                    result = await this.testInterGuildSystem();
                    break;
                default:
                    result = await this.testBasicFunctionality();
                    break;
            }

            const embed = this.createTestResultEmbed(testType, result);
            await message.reply({ embeds: [embed] });

            return { success: true, testType: testType, result: result };

        } catch (error) {
            logger.logError(error, 'Test command execution failed');
            throw error;
        }
    }

    /**
     * Handle help command
     */
    async handleHelpCommand(message, args) {
        try {
            const commandName = args[0];

            if (commandName) {
                // Show help for specific command
                const command = this.commands.get(commandName);
                if (!command) {
                    await this.sendErrorMessage(message, 'Command not found', `Command '${commandName}' does not exist`);
                    return { success: false, error: 'Command not found' };
                }

                const embed = this.createCommandHelpEmbed(commandName, command);
                await message.reply({ embeds: [embed] });
            } else {
                // Show all available commands
                const embed = this.createGeneralHelpEmbed(message);
                await message.reply({ embeds: [embed] });
            }

            return { success: true, command: commandName };

        } catch (error) {
            logger.logError(error, 'Help command execution failed');
            throw error;
        }
    }

    /**
     * Handle ping command
     */
    async handlePingCommand(message, args) {
        try {
            const startTime = Date.now();
            const reply = await message.reply('🏓 Pinging...');
            const endTime = Date.now();
            
            const latency = endTime - startTime;
            const apiLatency = message.client.ws.ping;

            const embed = this.embedBuilder.createInfoEmbed(
                '🏓 Pong!',
                `**Response Time:** ${latency}ms\n**API Latency:** ${apiLatency}ms`,
                'success'
            );

            await reply.edit({ content: '', embeds: [embed] });

            return { success: true, latency: latency, apiLatency: apiLatency };

        } catch (error) {
            logger.logError(error, 'Ping command execution failed');
            throw error;
        }
    }

    // ==================== EMBED CREATION METHODS ====================

    /**
     * Create status embed
     */
    createStatusEmbed(statusData) {
        const embed = this.embedBuilder.createInfoEmbed('📊 System Status', '', 'system');

        // System status
        if (statusData.system) {
            embed.addFields({
                name: '⚙️ System',
                value: [
                    `Status: ${statusData.system.running ? '✅ Running' : '❌ Stopped'}`,
                    `Uptime: ${statusData.system.uptime}`,
                    `Memory: ${statusData.system.memory.heapUsed}`,
                    `Version: ${statusData.system.version || 'Unknown'}`
                ].join('\n'),
                inline: true
            });
        }

        // Minecraft status
        if (statusData.minecraft) {
            embed.addFields({
                name: '🎮 Minecraft',
                value: [
                    `Initialized: ${statusData.minecraft.initialized ? '✅ Yes' : '❌ No'}`,
                    `Started: ${statusData.minecraft.started ? '✅ Yes' : '❌ No'}`,
                    `Connections: ${statusData.minecraft.connections?.active || 0}/${statusData.minecraft.connections?.guilds?.length || 0}`
                ].join('\n'),
                inline: true
            });
        }

        // Inter-guild status
        if (statusData.interGuild) {
            embed.addFields({
                name: '🌉 Inter-Guild',
                value: [
                    `Enabled: ${statusData.interGuild.enabled ? '✅ Yes' : '❌ No'}`,
                    `Queue: ${statusData.interGuild.stats?.queueSize || 0} messages`,
                    `Processed: ${statusData.interGuild.stats?.messagesProcessed || 0}`
                ].join('\n'),
                inline: true
            });
        }

        return embed;
    }

    /**
     * Create stats embed
     */
    createStatsEmbed(statsData, category) {
        const title = category ? `📈 Statistics - ${category}` : '📈 System Statistics';
        const embed = this.embedBuilder.createInfoEmbed(title, '', 'system');

        // Add stats fields based on available data
        for (const [key, value] of Object.entries(statsData)) {
            if (typeof value === 'object' && value !== null) {
                const fieldValue = Object.entries(value)
                    .map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : v}`)
                    .join('\n');
                
                embed.addFields({
                    name: key.charAt(0).toUpperCase() + key.slice(1),
                    value: fieldValue.substring(0, 1024), // Discord field limit
                    inline: true
                });
            }
        }

        return embed;
    }

    /**
     * Create health embed
     */
    createHealthEmbed(healthData) {
        const overallStatus = healthData.overall;
        const color = overallStatus === 'healthy' ? 'success' : 
                     overallStatus === 'warning' ? 'warning' : 'error';
        
        const emoji = overallStatus === 'healthy' ? '✅' : 
                     overallStatus === 'warning' ? '⚠️' : '❌';

        const embed = this.embedBuilder.createInfoEmbed(
            `${emoji} System Health - ${overallStatus.toUpperCase()}`,
            '',
            color
        );

        // Component health
        if (healthData.components) {
            for (const [component, data] of Object.entries(healthData.components)) {
                const statusEmoji = data.status === 'healthy' ? '✅' : 
                                  data.status === 'warning' ? '⚠️' : '❌';
                
                const details = Object.entries(data)
                    .filter(([k]) => k !== 'status')
                    .map(([k, v]) => `${k}: ${v}`)
                    .join('\n');

                embed.addFields({
                    name: `${statusEmoji} ${component}`,
                    value: details || 'No additional info',
                    inline: true
                });
            }
        }

        // Issues and warnings
        if (healthData.issues && healthData.issues.length > 0) {
            embed.addFields({
                name: '❌ Issues',
                value: healthData.issues.join('\n'),
                inline: false
            });
        }

        if (healthData.warnings && healthData.warnings.length > 0) {
            embed.addFields({
                name: '⚠️ Warnings',
                value: healthData.warnings.join('\n'),
                inline: false
            });
        }

        return embed;
    }

    /**
     * Create connections embed
     */
    createConnectionsEmbed(connectionData) {
        const embed = this.embedBuilder.createInfoEmbed('🔗 Minecraft Connections', '', 'system');

        if (connectionData.summary) {
            embed.setDescription([
                `**Total Guilds:** ${connectionData.summary.total}`,
                `**Connected:** ${connectionData.summary.connected}`,
                `**Success Rate:** ${((connectionData.summary.connected / connectionData.summary.total) * 100).toFixed(1)}%`
            ].join('\n'));
        }

        // Connected guilds
        if (connectionData.summary?.guilds && connectionData.summary.guilds.length > 0) {
            const guildList = connectionData.summary.guilds
                .map(guild => `✅ **${guild.guildName}** [${guild.guildTag}] (${guild.username})`)
                .join('\n');

            embed.addFields({
                name: '✅ Connected Guilds',
                value: guildList,
                inline: false
            });
        }

        return embed;
    }

    /**
     * Create test result embed
     */
    createTestResultEmbed(testType, result) {
        const success = result.success !== false;
        const color = success ? 'success' : 'error';
        const emoji = success ? '✅' : '❌';

        const embed = this.embedBuilder.createInfoEmbed(
            `${emoji} Test Results - ${testType}`,
            result.message || 'Test completed',
            color
        );

        if (result.details) {
            for (const [key, value] of Object.entries(result.details)) {
                embed.addFields({
                    name: key,
                    value: typeof value === 'object' ? JSON.stringify(value, null, 2) : String(value),
                    inline: true
                });
            }
        }

        return embed;
    }

    /**
     * Create command help embed
     */
    createCommandHelpEmbed(commandName, command) {
        return this.embedBuilder.createInfoEmbed(
            `ℹ️ Command Help - ${commandName}`,
            [
                `**Description:** ${command.description}`,
                `**Usage:** ${command.usage}`,
                `**Permission:** ${command.permission}`
            ].join('\n'),
            'system'
        );
    }

    /**
     * Create general help embed
     */
    createGeneralHelpEmbed(message) {
        const embed = this.embedBuilder.createInfoEmbed('ℹ️ Available Commands', '', 'system');

        const userCommands = [];
        const adminCommands = [];

        for (const [name, command] of this.commands.entries()) {
            const commandInfo = `**${this.prefix} ${name}** - ${command.description}`;
            
            if (command.permission === 'admin') {
                adminCommands.push(commandInfo);
            } else {
                userCommands.push(commandInfo);
            }
        }

        if (userCommands.length > 0) {
            embed.addFields({
                name: '👤 User Commands',
                value: userCommands.join('\n'),
                inline: false
            });
        }

        if (adminCommands.length > 0 && this.hasPermission(message, 'admin')) {
            embed.addFields({
                name: '🛡️ Admin Commands',
                value: adminCommands.join('\n'),
                inline: false
            });
        }

        embed.addFields({
            name: 'Usage',
            value: `Use \`${this.prefix} help <command>\` for detailed help on a specific command`,
            inline: false
        });

        return embed;
    }

    // ==================== TEST METHODS ====================

    async testBasicFunctionality() {
        return {
            success: true,
            message: 'Basic functionality test passed',
            details: {
                timestamp: new Date().toISOString(),
                commandHandler: 'operational',
                embedBuilder: 'operational'
            }
        };
    }

    async testDiscordFunctionality() {
        const mainBridge = BridgeLocator.getInstance();
        const discordManager = mainBridge.getDiscordManager?.();

        if (!discordManager) {
            return {
                success: false,
                message: 'Discord manager not available'
            };
        }

        const stats = discordManager.getStatistics();
        
        return {
            success: stats.connected,
            message: stats.connected ? 'Discord functionality test passed' : 'Discord not connected',
            details: {
                connected: stats.connected,
                botInfo: discordManager.getBotInfo(),
                statistics: stats
            }
        };
    }

    async testMinecraftConnections() {
        const mainBridge = BridgeLocator.getInstance();
        const minecraftManager = mainBridge.getMinecraftManager?.();

        if (!minecraftManager) {
            return {
                success: false,
                message: 'Minecraft manager not available'
            };
        }

        const status = minecraftManager.getConnectionStatus();
        const connectedGuilds = minecraftManager.getConnectedGuilds();

        return {
            success: connectedGuilds.length > 0,
            message: `${connectedGuilds.length} Minecraft connections active`,
            details: {
                connectionStatus: status,
                connectedGuilds: connectedGuilds
            }
        };
    }

    async testInterGuildSystem() {
        const result = await this.adminCommands.executeCommand('interguild test');
        
        return {
            success: result.success,
            message: result.success ? 'Inter-guild test completed' : 'Inter-guild test failed',
            details: result.result
        };
    }

    // ==================== UTILITY METHODS ====================

    /**
     * Check if user has permission for command
     */
    hasPermission(message, permission) {
        if (permission === 'user') {
            return true; // All users can use user commands
        }

        if (permission === 'admin') {
            // Check if user has administrator permission
            return message.member && message.member.permissions.has('Administrator');
        }

        return false;
    }

    /**
     * Check if user is on cooldown
     */
    isOnCooldown(userId) {
        const lastUsed = this.cooldowns.get(userId);
        if (!lastUsed) return false;
        
        return Date.now() - lastUsed < this.cooldownTime;
    }

    /**
     * Update user cooldown
     */
    updateCooldown(userId) {
        this.cooldowns.set(userId, Date.now());
    }

    /**
     * Send error message
     */
    async sendErrorMessage(message, title, description) {
        const embed = this.embedBuilder.createErrorEmbed(description, title);
        await message.reply({ embeds: [embed] });
    }

    /**
     * Get command statistics
     */
    getStatistics() {
        return {
            ...this.stats,
            availableCommands: this.commands.size,
            cooldownsActive: this.cooldowns.size
        };
    }

    /**
     * Clear expired cooldowns
     */
    cleanupCooldowns() {
        const now = Date.now();
        for (const [userId, lastUsed] of this.cooldowns.entries()) {
            if (now - lastUsed > this.cooldownTime) {
                this.cooldowns.delete(userId);
            }
        }
    }
}

module.exports = CommandHandler;