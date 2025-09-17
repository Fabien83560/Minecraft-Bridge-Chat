// Globals Imports
const fs = require('fs');
const path = require('path');

// Specific Imports
const logger = require('./shared/logger');
const Config = require("./config/ConfigLoader.js");
const MinecraftManager = require('./minecraft/MinecraftManager.js');
const SystemMonitor = require('./shared/SystemMonitor.js');
const AdminCommands = require('./shared/AdminCommands.js');
const BridgeLocator = require("./bridgeLocator.js");

class MainBridge {
    constructor() {
        this._startTime = Date.now();
        this._isRunning = false;

        this.config = new Config();
        this._minecraftManager = null;
        this._systemMonitor = null;
        this._adminCommands = null;

        // System statistics
        this.stats = {
            messagesProcessed: 0,
            eventsProcessed: 0,
            errors: 0,
            startTime: this._startTime
        };

        // Health check interval
        this._healthCheckInterval = null;
    }

    async start() {
        logger.info("===========================================");
        logger.info("========= 🚀 Starting Application =========");
        logger.info("===========================================");

        try {
            // Step 1: Initialize core systems
            await this.initializeCoreSystems();

            // Step 2: Initialize monitoring and admin systems
            await this.initializeManagementSystems();

            // Step 3: Initialize Minecraft Module
            await this.initializeMinecraftModule();

            // Step 4: Finalize startup
            await this.finalizeStartup();

            this._isRunning = true;
            
            const uptime = Date.now() - this._startTime;
            logger.info("===========================================");
            logger.info(`=== ✅ Application Started (${uptime}ms) ===`);
            logger.info("===========================================");

        } catch (error) {
            logger.logError(error, 'Application startup failed');
            throw error;
        }
    }

    async stop() {
        logger.info("===========================================");
        logger.info("========== 🛑 Stopping Application ==========");
        logger.info("===========================================");

        const stopStartTime = Date.now();

        try {
            // Stop health checks
            if (this._healthCheckInterval) {
                clearInterval(this._healthCheckInterval);
                this._healthCheckInterval = null;
            }

            // Stop system monitoring
            if (this._systemMonitor) {
                this._systemMonitor.stopMonitoring();
                logger.info('✅ System monitoring stopped');
            }

            // Stop Minecraft connections
            if (this._minecraftManager) {
                await this._minecraftManager.stop();
                logger.info('✅ Minecraft connections stopped');
            }

            this._isRunning = false;

            const stopTime = Date.now() - stopStartTime;
            const totalUptime = Date.now() - this._startTime;
            
            logger.info(`✅ Application stopped gracefully in ${stopTime}ms (Total uptime: ${this.formatUptime(totalUptime)})`);
            
        } catch (error) {
            logger.logError(error, 'Error during application shutdown');
            throw error;
        }
    }

    async initializeCoreSystems() {
        logger.info("===========================================");
        logger.info("====== ⚙️  Initializing core systems  ======");
        logger.info("===========================================");

        const stepStartTime = Date.now();
        
        try {
            // Get directory paths from configuration
            const requiredDirs = this.getRequiredDirectories();
            
            let createdDirs = 0;
            let checkedDirs = 0;
            
            for (const [dirType, dirPath] of Object.entries(requiredDirs)) {
                const fullPath = path.resolve(dirPath);
                checkedDirs++;
                
                if (!fs.existsSync(fullPath)) {
                    try {
                        fs.mkdirSync(fullPath, { recursive: true });
                        logger.info(`📁 Created ${dirType} directory: ${dirPath}`);
                        createdDirs++;
                    } catch (dirError) {
                        logger.logError(dirError, `Failed to create ${dirType} directory: ${dirPath}`);
                        throw dirError;
                    }
                } else {
                    logger.debug(`${dirType} directory exists: ${dirPath}`);
                }
            }
            
            if (createdDirs > 0) {
                logger.info(`📁 Created ${createdDirs}/${checkedDirs} missing directories`);
            }
            else {
                logger.debug(`📁 All ${checkedDirs} required directories already exist`);
            }
            
            // Verify logging configuration and directory
            const loggingConfig = this.config.get("features.logging");
            logger.debug('Logging configuration:', loggingConfig);
            
            if (loggingConfig.file) {
                logger.info('📝 File logging enabled');
                logger.debug(`Log files location: ${requiredDirs.logs}`);
            }
            
            // Log all configured paths for debug
            logger.debug('Configured directories:', requiredDirs);
            
            logger.logPerformance('Core systems initialization', stepStartTime);
            logger.info('✅ Core systems initialized');
        
        } catch (error) {
            logger.logError(error, 'Core systems initialization failed');
            throw new Error(`Core systems initialization failed: ${error.message}`);
        }
    }

    async initializeManagementSystems() {
        logger.info("===========================================");
        logger.info("===== ⚙️  Initializing Management ======");
        logger.info("===========================================");

        const stepStartTime = Date.now();

        try {
            // Initialize system monitor
            this._systemMonitor = new SystemMonitor();
            logger.info('✅ System monitor initialized');

            // Initialize admin commands
            this._adminCommands = new AdminCommands();
            logger.info('✅ Admin commands initialized');

            logger.logPerformance('Management systems initialization', stepStartTime);
            logger.info('✅ Management systems initialized');

        } catch (error) {
            logger.logError(error, 'Management systems initialization failed');
            throw new Error(`Management systems initialization failed: ${error.message}`);
        }
    }

    async initializeMinecraftModule() {
        logger.info("===========================================");
        logger.info("==== 🎮  Initializing Minecraft Module ====");
        logger.info("===========================================");

        const stepStartTime = Date.now();
        try {
            this._minecraftManager = new MinecraftManager();
            await this._minecraftManager.start();
            
            // Set up event handlers for statistics and monitoring
            this.setupMinecraftEventHandlers();
            
            logger.logPerformance('Minecraft module initialization', stepStartTime);
            logger.minecraft('✅ Minecraft module initialized');
        } catch (error) {
            logger.logError(error, 'Minecraft module initialization failed');
            throw new Error(`Minecraft module initialization failed: ${error.message}`);
        }
    }

    async finalizeStartup() {
        logger.info("===========================================");
        logger.info("======= 🎯 Finalizing Startup =======");
        logger.info("===========================================");

        const stepStartTime = Date.now();

        try {
            // Log startup summary
            this.logStartupSummary();

            // Start periodic health checks
            this.startHealthChecks();

            logger.logPerformance('Startup finalization', stepStartTime);
            logger.info('✅ Startup finalized');

        } catch (error) {
            logger.logError(error, 'Startup finalization failed');
            throw new Error(`Startup finalization failed: ${error.message}`);
        }
    }

    setupMinecraftEventHandlers() {
        if (!this._minecraftManager) {
            return;
        }

        this._minecraftManager.onConnection((connectionData) => {
            if (connectionData.type === 'connected') {
                logger.logMinecraftConnection(connectionData.guildId, connectionData.username, 'connected');
            } else if (connectionData.type === 'disconnected') {
                logger.logMinecraftConnection(connectionData.guildId, connectionData.username, 'disconnected', { 
                    reason: connectionData.reason 
                });
            } else if (connectionData.type === 'reconnected') {
                logger.logMinecraftConnection(connectionData.guildId, connectionData.username, 'reconnected');
            }
        });
        
        this._minecraftManager.onError((error, guildId) => {
            this.stats.errors++;
            logger.logError(error, `Minecraft connection error for guild: ${guildId}`);
        });

        this._minecraftManager.onMessage((messageData) => {
            this.stats.messagesProcessed++;
            
            if (this.config.get('features.messageSystem.enableDebugLogging')) {
                logger.debug(`[STATS] Messages processed: ${this.stats.messagesProcessed}`);
            }
        });

        this._minecraftManager.onEvent((eventData) => {
            this.stats.eventsProcessed++;
            
            if (this.config.get('features.messageSystem.enableDebugLogging')) {
                logger.debug(`[STATS] Events processed: ${this.stats.eventsProcessed}`);
            }
        });
    }

    logStartupSummary() {
        const enabledGuilds = this.config.getEnabledGuilds();
        const interGuildEnabled = this.config.get('bridge.interGuild.enabled');
        const showTags = this.config.get('bridge.interGuild.showTags');
        const showSourceTag = this.config.get('bridge.interGuild.showSourceTag');

        logger.info("📊 Startup Summary:");
        logger.info(`   • Guilds configured: ${enabledGuilds.length}`);
        logger.info(`   • Inter-guild enabled: ${interGuildEnabled ? '✅' : '❌'}`);
        
        if (interGuildEnabled) {
            logger.info(`   • Show user tags: ${showTags ? '✅' : '❌'}`);
            logger.info(`   • Show source tags: ${showSourceTag ? '✅' : '❌'}`);
        }
        
        logger.info(`   • Monitoring enabled: ${this.config.get('advanced.performance.enablePerformanceMonitoring') ? '✅' : '❌'}`);
        logger.info(`   • Log level: ${logger.getLevel()}`);

        // List configured guilds
        enabledGuilds.forEach(guild => {
            logger.info(`   • Guild: ${guild.name} [${guild.tag}] (${guild.server.serverName})`);
        });
    }

    startHealthChecks() {
        // Periodic health checks every 10 minutes
        this._healthCheckInterval = setInterval(() => {
            this.performHealthCheck();
        }, 10 * 60 * 1000);

        logger.debug('Health checks started (10-minute interval)');
    }

    async performHealthCheck() {
        try {
            if (!this._adminCommands) {
                return;
            }

            const health = await this._adminCommands.getHealthStatus();
            
            if (health.overall === 'critical') {
                logger.error(`🚨 CRITICAL system health issues detected: ${health.issues.join(', ')}`);
            } else if (health.overall === 'warning') {
                logger.warn(`⚠️ System health warnings: ${[...health.issues, ...health.warnings].join(', ')}`);
            } else {
                logger.debug('✅ System health check passed');
            }

        } catch (error) {
            logger.logError(error, 'Error during health check');
        }
    }

    getRequiredDirectories() {
        // Get auth cache path from first enabled guild account
        const enabledGuilds = this.config.get("guilds").filter(guild => guild.enabled);
        let authCachePath = './data/auth-cache';
        
        if (enabledGuilds.length > 0) {
            // Use sessionPath from first guild as primary auth cache location
            const firstGuild = enabledGuilds[0];
            authCachePath = firstGuild.account.sessionPath || firstGuild.account.cachePath || authCachePath;
            logger.debug(`Using auth cache path from ${firstGuild.name}: ${authCachePath}`);
        }
        
        const loggingConfig = this.config.get("features.logging");
        const enabledFileLogging = loggingConfig.file;
        let logsPath = './data/logs';

        if (enabledFileLogging) {
            logsPath = loggingConfig.logFileDirectory;
        }
        
        const databasePath = './data/database'; // TODO: Make configurable in settings
        const backupsPath = './data/backups'; // TODO: Make configurable in settings
        
        const directories = {
            data: 'data',
            logs: logsPath,
            database: databasePath,
            backups: backupsPath,
            authCache: authCachePath
        };
        
        // Check if different guilds use different auth paths
        const uniqueAuthPaths = new Set();
        enabledGuilds.forEach(guild => {
            const sessionPath = guild.account.sessionPath || authCachePath;
            const cachePath = guild.account.cachePath || authCachePath;
            const profilesPath = guild.account.profilesFolder || authCachePath;
            
            uniqueAuthPaths.add(sessionPath);
            uniqueAuthPaths.add(cachePath);
            uniqueAuthPaths.add(profilesPath);
        });
        
        // Add additional auth directories if guilds use different paths
        if (uniqueAuthPaths.size > 1) {
            logger.debug(`Multiple auth cache paths detected: ${Array.from(uniqueAuthPaths).join(', ')}`);
            let authIndex = 1;
            uniqueAuthPaths.forEach(authPath => {
                if (authPath !== authCachePath) {
                    directories[`authCache${authIndex}`] = authPath;
                    authIndex++;
                }
            });
        }
        
        return directories;
    }

    isRunning() {
        return this._isRunning;
    }

    // Administration and monitoring methods
    async executeAdminCommand(commandLine) {
        if (!this._adminCommands) {
            return { success: false, error: 'Admin commands not initialized' };
        }

        return await this._adminCommands.executeCommand(commandLine);
    }

    getSystemStats() {
        const baseStats = {
            ...this.stats,
            uptime: Date.now() - this._startTime,
            isRunning: this._isRunning
        };

        if (this._minecraftManager) {
            baseStats.minecraft = {
                connections: this._minecraftManager.getConnectionStatus(),
                connectedGuilds: this._minecraftManager.getConnectedGuilds(),
                interGuildStats: this._minecraftManager.getInterGuildStats()
            };
        }

        if (this._systemMonitor) {
            baseStats.monitoring = this._systemMonitor.getStatistics();
        }

        return baseStats;
    }

    async getHealthStatus() {
        if (!this._adminCommands) {
            return { overall: 'unknown', error: 'Health system not initialized' };
        }

        return await this._adminCommands.getHealthStatus();
    }

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

    // Inter-guild specific methods
    getInterGuildConfig() {
        return this.config.get('bridge.interGuild');
    }

    updateInterGuildConfig(newConfig) {
        // Update configuration
        const currentConfig = this.config.get('bridge.interGuild');
        const updatedConfig = { ...currentConfig, ...newConfig };
        
        // This would need to be saved to the config file in a real implementation
        // For now, we'll just update the runtime config
        
        if (this._minecraftManager) {
            this._minecraftManager.updateInterGuildConfig(updatedConfig);
            logger.info('Inter-guild configuration updated', updatedConfig);
        }

        return updatedConfig;
    }

    testInterGuildFormatting(testData) {
        if (!this._minecraftManager) {
            return { error: 'Minecraft manager not initialized' };
        }

        return this._minecraftManager.testMessageFormatting(testData);
    }

    // Convenience methods for external access
    getMinecraftManager() {
        return this._minecraftManager;
    }

    getSystemMonitor() {
        return this._systemMonitor;
    }

    getAdminCommands() {
        return this._adminCommands;
    }
}

let mainInstance = null;

async function main() {
    try {
        mainInstance = new MainBridge();
        BridgeLocator.setInstance(mainInstance);
        await mainInstance.start();
    } catch (error) {
        logger.logError(error, 'Main function execution failed');
        process.exit(1);
    }
}

// Signal handling for clean shutdown
process.on('SIGINT', async () => {
    logger.info('🛑 Shutdown signal received (Ctrl+C)...');
    await handleShutdown('SIGINT');
});

process.on('SIGTERM', async () => {
    logger.info('🛑 Termination signal received...');
    await handleShutdown('SIGTERM');
});

async function handleShutdown(signal) {
    try {
        logger.debug(`Processing ${signal} signal`);
        if (mainInstance) {
            await mainInstance.stop();
        }
        logger.info('🏁 Process exiting cleanly');
        process.exit(0);
    } catch (error) {
        logger.logError(error, `Error during ${signal} shutdown`);
        process.exit(1);
    }
}

// Uncaught error handling
process.on('uncaughtException', (error) => {
    logger.logError(error, 'Uncaught exception - process will exit');
    process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
    const error = new Error(`Unhandled promise rejection: ${reason}`);
    logger.logError(error, 'Unhandled promise rejection - process will exit');
    logger.debug('Rejected promise:', promise);
    process.exit(1);
});

// Start the application
if (require.main === module) {
    main();
}

module.exports = MainBridge;