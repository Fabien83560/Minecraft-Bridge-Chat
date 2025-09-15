// Specific Imports
const logger = require('./logger');
const BridgeLocator = require('../bridgeLocator.js');

class AdminCommands {
    constructor() {
        this.commands = new Map();
        this.setupCommands();
        
        logger.debug('AdminCommands initialized');
    }

    /**
     * Set up available admin commands
     */
    setupCommands() {
        // System commands
        this.commands.set('status', {
            description: 'Show system status',
            usage: 'status',
            execute: this.getSystemStatus.bind(this)
        });

        this.commands.set('stats', {
            description: 'Show detailed statistics',
            usage: 'stats [category]',
            execute: this.getDetailedStats.bind(this)
        });

        this.commands.set('health', {
            description: 'Show system health',
            usage: 'health',
            execute: this.getHealthStatus.bind(this)
        });

        // Inter-guild commands
        this.commands.set('interguild', {
            description: 'Manage inter-guild system',
            usage: 'interguild <enable|disable|status|clear|test>',
            execute: this.manageInterGuild.bind(this)
        });

        // Connection commands
        this.commands.set('connections', {
            description: 'Show connection status',
            usage: 'connections',
            execute: this.getConnectionStatus.bind(this)
        });

        this.commands.set('reconnect', {
            description: 'Reconnect a guild or all guilds',
            usage: 'reconnect [guildId]',
            execute: this.reconnectGuild.bind(this)
        });

        // Template commands
        this.commands.set('templates', {
            description: 'Manage message templates',
            usage: 'templates <reload|test|list>',
            execute: this.manageTemplates.bind(this)
        });

        // Logging commands
        this.commands.set('loglevel', {
            description: 'Change log level',
            usage: 'loglevel <debug|info|warn|error>',
            execute: this.changeLogLevel.bind(this)
        });

        // Cache commands
        this.commands.set('cache', {
            description: 'Manage system cache',
            usage: 'cache <clear|status>',
            execute: this.manageCache.bind(this)
        });
    }

    /**
     * Execute an admin command
     * @param {string} commandLine - Full command line
     * @returns {object} Command result
     */
    async executeCommand(commandLine) {
        try {
            const args = commandLine.trim().split(/\s+/);
            const commandName = args[0].toLowerCase();
            const commandArgs = args.slice(1);

            if (!this.commands.has(commandName)) {
                return {
                    success: false,
                    error: `Unknown command: ${commandName}`,
                    suggestion: this.getSuggestion(commandName)
                };
            }

            const command = this.commands.get(commandName);
            logger.info(`🔧 Executing admin command: ${commandLine}`);

            const result = await command.execute(commandArgs);
            
            return {
                success: true,
                command: commandName,
                result: result
            };

        } catch (error) {
            logger.logError(error, `Error executing command: ${commandLine}`);
            return {
                success: false,
                error: error.message,
                command: commandLine
            };
        }
    }

    /**
     * Get system status
     */
    async getSystemStatus() {
        const mainBridge = BridgeLocator.getInstance();
        
        const status = {
            system: {
                running: mainBridge.isRunning(),
                uptime: this.formatUptime(Date.now() - mainBridge._startTime),
                memory: this.formatMemory(process.memoryUsage()),
                version: mainBridge.config.get('app.version')
            },
            minecraft: {
                initialized: !!mainBridge._minecraftManager,
                started: mainBridge._minecraftManager?._isStarted || false
            },
            interGuild: {
                enabled: mainBridge.config.get('bridge.interGuild.enabled'),
                stats: mainBridge._minecraftManager?.getInterGuildStats() || null
            }
        };

        if (mainBridge._minecraftManager) {
            const connectedGuilds = mainBridge._minecraftManager.getConnectedGuilds();
            status.minecraft.connections = {
                active: connectedGuilds.length,
                guilds: connectedGuilds.map(g => ({ name: g.guildName, tag: g.guildTag }))
            };
        }

        return status;
    }

    /**
     * Get detailed statistics
     */
    async getDetailedStats(args) {
        const category = args[0]?.toLowerCase();
        const mainBridge = BridgeLocator.getInstance();
        
        const allStats = {
            system: {
                uptime: Date.now() - mainBridge._startTime,
                memory: process.memoryUsage(),
                platform: process.platform,
                nodeVersion: process.version
            }
        };

        // Add Minecraft stats
        if (mainBridge._minecraftManager) {
            allStats.minecraft = {
                connections: mainBridge._minecraftManager.getConnectionStatus(),
                connectedGuilds: mainBridge._minecraftManager.getConnectedGuilds()
            };
        }

        // Add inter-guild stats
        const interGuildStats = mainBridge._minecraftManager?.getInterGuildStats();
        if (interGuildStats) {
            allStats.interGuild = interGuildStats;
        }

        // Return specific category or all stats
        if (category && allStats[category]) {
            return { [category]: allStats[category] };
        }

        return allStats;
    }

    /**
     * Get system health status
     */
    async getHealthStatus() {
        const mainBridge = BridgeLocator.getInstance();
        const health = {
            overall: 'healthy',
            components: {},
            issues: [],
            warnings: []
        };

        // Check system health
        const memoryMB = process.memoryUsage().heapUsed / 1024 / 1024;
        health.components.system = {
            status: memoryMB > 1024 ? 'warning' : 'healthy',
            memory: `${Math.round(memoryMB)}MB`
        };

        // Check Minecraft connections
        if (mainBridge._minecraftManager) {
            const connectedGuilds = mainBridge._minecraftManager.getConnectedGuilds();
            const totalGuilds = mainBridge.config.getEnabledGuilds().length;
            
            health.components.minecraft = {
                status: connectedGuilds.length === totalGuilds ? 'healthy' : 'warning',
                connections: `${connectedGuilds.length}/${totalGuilds}`
            };

            if (connectedGuilds.length < totalGuilds) {
                health.warnings.push('Some guilds are disconnected');
            }
        }

        // Check inter-guild system
        const interGuildStats = mainBridge._minecraftManager?.getInterGuildStats();
        if (interGuildStats) {
            health.components.interGuild = {
                status: interGuildStats.queueSize > 100 ? 'warning' : 'healthy',
                queue: interGuildStats.queueSize,
                dropped: interGuildStats.messagesDropped
            };

            if (interGuildStats.messagesDropped > 10) {
                health.issues.push('Messages being dropped in inter-guild system');
            }
        }

        // Determine overall health
        const componentStatuses = Object.values(health.components).map(c => c.status);
        if (componentStatuses.includes('critical')) {
            health.overall = 'critical';
        } else if (componentStatuses.includes('warning') || health.issues.length > 0) {
            health.overall = 'warning';
        }

        return health;
    }

    /**
     * Manage inter-guild system
     */
    async manageInterGuild(args) {
        const action = args[0]?.toLowerCase();
        const mainBridge = BridgeLocator.getInstance();

        if (!action) {
            return {
                error: 'Action required: enable, disable, status, clear, or test'
            };
        }

        switch (action) {
            case 'status':
                return mainBridge._minecraftManager?.getInterGuildStats() || { error: 'Not available' };

            case 'enable':
                mainBridge._minecraftManager?.updateInterGuildConfig({ enabled: true });
                return { message: 'Inter-guild system enabled' };

            case 'disable':
                mainBridge._minecraftManager?.updateInterGuildConfig({ enabled: false });
                return { message: 'Inter-guild system disabled' };

            case 'clear':
                mainBridge._minecraftManager?.clearInterGuildCache();
                return { message: 'Inter-guild cache cleared' };

            case 'test':
                const testData = { username: 'TestUser', message: 'Test message from admin command' };
                return mainBridge._minecraftManager?.testMessageFormatting(testData) || { error: 'Not available' };

            default:
                return { error: `Unknown action: ${action}` };
        }
    }

    /**
     * Get connection status
     */
    async getConnectionStatus() {
        const mainBridge = BridgeLocator.getInstance();
        
        if (!mainBridge._minecraftManager) {
            return { error: 'Minecraft manager not initialized' };
        }

        const status = mainBridge._minecraftManager.getConnectionStatus();
        const connectedGuilds = mainBridge._minecraftManager.getConnectedGuilds();

        return {
            detailed: status,
            summary: {
                total: Object.keys(status).length,
                connected: connectedGuilds.length,
                guilds: connectedGuilds
            }
        };
    }

    /**
     * Reconnect guild(s)
     */
    async reconnectGuild(args) {
        const guildId = args[0];
        // This would need to be implemented in the MinecraftManager
        return { error: 'Reconnect functionality not yet implemented' };
    }

    /**
     * Manage templates
     */
    async manageTemplates(args) {
        const action = args[0]?.toLowerCase();

        switch (action) {
            case 'reload':
                try {
                    const { getTemplateLoader } = require('../config/TemplateLoader.js');
                    getTemplateLoader().reload();
                    return { message: 'Templates reloaded successfully' };
                } catch (error) {
                    return { error: `Failed to reload templates: ${error.message}` };
                }

            case 'list':
                const { getTemplateLoader } = require('../config/TemplateLoader.js');
                const stats = getTemplateLoader().getStatistics();
                return stats;

            case 'test':
                const templateLoader = require('../config/TemplateLoader.js').getTemplateLoader();
                const testResult = templateLoader.testPatterns('Hypixel', 'messages', 'guild', 'Guild > TestUser: Hello world!');
                return testResult;

            default:
                return { error: 'Action required: reload, list, or test' };
        }
    }

    /**
     * Change log level
     */
    async changeLogLevel(args) {
        const level = args[0]?.toLowerCase();
        const validLevels = ['debug', 'info', 'warn', 'error'];

        if (!level || !validLevels.includes(level)) {
            return { 
                error: `Invalid log level. Valid levels: ${validLevels.join(', ')}`,
                current: logger.getLevel()
            };
        }

        const oldLevel = logger.getLevel();
        logger.setLevel(level);
        
        return { 
            message: `Log level changed from ${oldLevel} to ${level}`,
            oldLevel: oldLevel,
            newLevel: level
        };
    }

    /**
     * Manage cache
     */
    async manageCache(args) {
        const action = args[0]?.toLowerCase();

        switch (action) {
            case 'clear':
                // Clear various caches
                const { getTemplateLoader } = require('../config/TemplateLoader.js');
                const { getPatternLoader } = require('../config/PatternLoader.js');
                
                getTemplateLoader().clearCache();
                getPatternLoader().clearCache();

                const mainBridge = BridgeLocator.getInstance();
                mainBridge._minecraftManager?.clearInterGuildCache();

                return { message: 'All caches cleared' };

            case 'status':
                const templateStats = require('../config/TemplateLoader.js').getTemplateLoader().getStatistics();
                const patternStats = require('../config/PatternLoader.js').getPatternLoader().getStatistics();
                
                return {
                    templates: { cacheSize: templateStats.cacheSize },
                    patterns: { cacheSize: patternStats.cacheSize },
                    interGuild: mainBridge._minecraftManager?.getInterGuildStats() || null
                };

            default:
                return { error: 'Action required: clear or status' };
        }
    }

    /**
     * Get command suggestion for typos
     * @param {string} command - Mistyped command
     * @returns {string|null} Suggested command
     */
    getSuggestion(command) {
        const commandNames = Array.from(this.commands.keys());
        
        // Simple Levenshtein distance for suggestions
        let bestMatch = null;
        let bestDistance = Infinity;

        for (const commandName of commandNames) {
            const distance = this.levenshteinDistance(command, commandName);
            if (distance < bestDistance && distance <= 2) {
                bestDistance = distance;
                bestMatch = commandName;
            }
        }

        return bestMatch ? `Did you mean '${bestMatch}'?` : null;
    }

    /**
     * Calculate Levenshtein distance between two strings
     * @param {string} a - First string
     * @param {string} b - Second string
     * @returns {number} Edit distance
     */
    levenshteinDistance(a, b) {
        if (a.length === 0) return b.length;
        if (b.length === 0) return a.length;

        const matrix = Array(b.length + 1).fill().map(() => Array(a.length + 1).fill(0));

        for (let i = 0; i <= a.length; i++) matrix[0][i] = i;
        for (let j = 0; j <= b.length; j++) matrix[j][0] = j;

        for (let j = 1; j <= b.length; j++) {
            for (let i = 1; i <= a.length; i++) {
                const substitutionCost = a[i - 1] === b[j - 1] ? 0 : 1;
                matrix[j][i] = Math.min(
                    matrix[j][i - 1] + 1,
                    matrix[j - 1][i] + 1,
                    matrix[j - 1][i - 1] + substitutionCost
                );
            }
        }

        return matrix[b.length][a.length];
    }

    /**
     * Format uptime in human readable format
     * @param {number} ms - Uptime in milliseconds
     * @returns {string} Formatted uptime
     */
    formatUptime(ms) {
        const seconds = Math.floor(ms / 1000);
        const minutes = Math.floor(seconds / 60);
        const hours = Math.floor(minutes / 60);
        const days = Math.floor(hours / 24);

        if (days > 0) return `${days}d ${hours % 24}h ${minutes % 60}m`;
        if (hours > 0) return `${hours}h ${minutes % 60}m`;
        if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
        return `${seconds}s`;
    }

    /**
     * Format memory usage
     * @param {object} memoryUsage - Process memory usage object
     * @returns {object} Formatted memory usage
     */
    formatMemory(memoryUsage) {
        return {
            rss: `${Math.round(memoryUsage.rss / 1024 / 1024)}MB`,
            heapTotal: `${Math.round(memoryUsage.heapTotal / 1024 / 1024)}MB`,
            heapUsed: `${Math.round(memoryUsage.heapUsed / 1024 / 1024)}MB`,
            external: `${Math.round(memoryUsage.external / 1024 / 1024)}MB`
        };
    }

    /**
     * Get list of available commands
     * @returns {object} Commands with descriptions
     */
    getAvailableCommands() {
        const commandList = {};
        
        for (const [name, command] of this.commands.entries()) {
            commandList[name] = {
                description: command.description,
                usage: command.usage
            };
        }

        return commandList;
    }
}

module.exports = AdminCommands;