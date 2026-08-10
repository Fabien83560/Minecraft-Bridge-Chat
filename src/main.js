/**
 * Main Application Entry Point
 * 
 * This file serves as the main entry point and orchestrator for the Minecraft-Discord Bridge application.
 * It initializes and coordinates all major subsystems including Minecraft bots, Discord client, and the
 * bridge system that connects them. The MainBridge class manages the complete lifecycle of the application
 * from startup to shutdown, ensuring proper initialization order and graceful error handling.
 * 
 * Key Responsibilities:
 * - Initialize all core systems and directories
 * - Start and manage Minecraft and Discord connections
 * - Set up cross-manager integrations for message bridging
 * - Handle graceful shutdown on termination signals
 * - Coordinate event flow between subsystems
 * 
 * @author Fabien83560
 * @version 1.0.0
 * @license ISC
 */

// Globals Imports
const fs = require('fs');
const path = require('path');

// Specific Imports
const logger = require('./shared/logger');
const Config = require("./config/ConfigLoader.js");
const MinecraftManager = require('./minecraft/MinecraftManager.js');
const DiscordManager = require('./discord/DiscordManager.js');
const BridgeLocator = require("./bridgeLocator.js");
const metrics = require('./shared/BridgeMetrics.js');

/**
 * MainBridge - Core application orchestrator
 * 
 * Manages the complete lifecycle of the bridge application including:
 * - Initialization of all subsystems
 * - Coordinated startup sequence
 * - Event handler registration
 * - Graceful shutdown procedures
 * 
 * @class
 */
class MainBridge {
    /**
     * Initialize MainBridge instance
     * Sets up timing tracking and configuration management
     */
    constructor() {
        this._startTime = Date.now();
        this._isRunning = false;

        this.config = new Config();
        this._minecraftManager = null;
        this._discordManager = null;
    }

    /**
     * Start the application
     * 
     * Executes a sequential startup process:
     * 1. Initialize core systems (directories, logging)
     * 2. Initialize management systems
     * 3. Initialize Minecraft connections
     * 4. Initialize Discord bot
     * 5. Setup cross-manager integration
     * 6. Finalize startup and log summary
     * 
     * @async
     * @returns {Promise}
     * @throws {Error} If any initialization step fails
     */
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

            // Step 4: Initialize Discord Module
            await this.initializeDiscordModule();

            // Step 5: Setup Cross-Manager Integration
            this.setupCrossManagerIntegration();

            // Step 6: Finalize startup
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

    /**
     * Stop the application gracefully
     * 
     * Performs controlled shutdown:
     * 1. Stops all Minecraft bot connections
     * 2. Disconnects Discord bot
     * 3. Cleans up resources
     * 4. Reports shutdown metrics
     * 
     * @async
     * @returns {Promise}
     * @throws {Error} If shutdown process encounters errors
     */
    async stop() {
        logger.info("===========================================");
        logger.info("========== 🛑 Stopping Application ==========");
        logger.info("===========================================");

        const stopStartTime = Date.now();

        try {
            // Report final delivery numbers before tearing anything down
            metrics.stopSummary();
            metrics.logSummary();

            // Stop Minecraft connections
            if (this._minecraftManager) {
                await this._minecraftManager.stop();
                logger.info('✅ Minecraft connections stopped');
            }

            // Stop Discord connections
            if (this._discordManager) {
                await this._discordManager.stop();
                logger.info('✅ Discord connections stopped');
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

    /**
     * Initialize core systems
     * 
     * Creates required directories and validates logging configuration.
     * Ensures all necessary file system paths exist before other systems start.
     * 
     * @async
     * @private
     * @returns {Promise}
     * @throws {Error} If directory creation fails
     */
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
            
            // Create missing directories
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
            
            // Verify logging configuration
            const loggingConfig = this.config.get("features.logging");
            
            if (loggingConfig.file) {
                logger.info('📝 File logging enabled');
            }
            
            logger.logPerformance('Core systems initialization', stepStartTime);
            logger.info('✅ Core systems initialized');
        
        } catch (error) {
            logger.logError(error, 'Core systems initialization failed');
            throw new Error(`Core systems initialization failed: ${error.message}`);
        }
    }

    /**
     * Initialize management systems
     * 
     * Reserved for future monitoring and administration features.
     * Currently a placeholder for system management initialization.
     * 
     * @async
     * @private
     * @returns {Promise}
     */
    async initializeManagementSystems() {
        logger.info("===========================================");
        logger.info("===== ⚙️  Initializing Management ======");
        logger.info("===========================================");

        const stepStartTime = Date.now();

        try {
            // Reserved for future management system initialization
            logger.logPerformance('Management systems initialization', stepStartTime);
            logger.info('✅ Management systems initialized');

        } catch (error) {
            logger.logError(error, 'Management systems initialization failed');
            throw new Error(`Management systems initialization failed: ${error.message}`);
        }
    }

    /**
     * Initialize Minecraft module
     * 
     * Creates and starts the MinecraftManager which handles:
     * - Multiple bot connections
     * - Guild chat monitoring
     * - Event detection
     * - Message parsing and routing
     * 
     * @async
     * @private
     * @returns {Promise}
     * @throws {Error} If Minecraft initialization fails
     */
    async initializeMinecraftModule() {
        logger.info("===========================================");
        logger.info("==== 🎮  Initializing Minecraft Module ====");
        logger.info("===========================================");

        const stepStartTime = Date.now();
        try {
            this._minecraftManager = new MinecraftManager();
            await this._minecraftManager.start();
            
            // Set up event handlers for Minecraft events
            this.setupMinecraftEventHandlers();
            
            logger.logPerformance('Minecraft module initialization', stepStartTime);
            logger.minecraft('✅ Minecraft module initialized');
        } catch (error) {
            logger.logError(error, 'Minecraft module initialization failed');
            throw new Error(`Minecraft module initialization failed: ${error.message}`);
        }
    }

    /**
     * Initialize Discord module
     * 
     * Creates and starts the DiscordManager which handles:
     * - Discord bot connection
     * - Slash command registration
     * - Message handling
     * - Embed creation and sending
     * 
     * @async
     * @private
     * @returns {Promise}
     * @throws {Error} If Discord initialization fails
     */
    async initializeDiscordModule() {
        logger.info("===========================================");
        logger.info("==== 💬  Initializing Discord Module ====");
        logger.info("===========================================");

        const stepStartTime = Date.now();

        try {
            this._discordManager = new DiscordManager();
            await this._discordManager.start();
            
            // Set up event handlers for Discord events
            this.setupDiscordEventHandlers();
            
            logger.logPerformance('Discord module initialization', stepStartTime);
            logger.discord('✅ Discord module initialized');

        } catch (error) {
            logger.logError(error, 'Discord module initialization failed');
            throw new Error(`Discord module initialization failed: ${error.message}`);
        }
    }

    /**
     * Setup cross-manager integration
     * 
     * Establishes bidirectional communication between Minecraft and Discord:
     * - Minecraft manager gets reference to Discord manager
     * - Discord manager gets reference to Minecraft manager
     * - Enables message bridging in both directions
     * 
     * @private
     */
    setupCrossManagerIntegration() {
        logger.info("===========================================");
        logger.info("=== 🔗  Setting up Cross-Integration ===");
        logger.info("===========================================");

        const stepStartTime = Date.now();

        try {
            // Establish cross-references between managers
            if (this._minecraftManager && this._discordManager) {
                this._minecraftManager.setDiscordManager(this._discordManager);
                logger.bridge('✅ Discord manager linked to Minecraft manager');
            }

            logger.logPerformance('Cross-manager integration', stepStartTime);

        } catch (error) {
            logger.logError(error, 'Cross-manager integration failed');
        }
    }

    /**
     * Setup Minecraft event handlers
     * 
     * Registers listeners for Minecraft events:
     * - Connection status changes
     * - Guild chat messages
     * - Guild events (join/leave/promote/etc)
     * - Connection errors
     * 
     * @private
     */
    setupMinecraftEventHandlers() {
        if (!this._minecraftManager) {
            return;
        }

        // Handle connection status changes
        this._minecraftManager.onConnection((connectionData) => {
            if (connectionData.type === 'connected') {
                logger.minecraft(`Guild bot connected: ${connectionData.guildName} (${connectionData.username})`);
            } else if (connectionData.type === 'disconnected') {
                logger.minecraft(`Guild bot disconnected: ${connectionData.guildName}`);
            }
        });
        
        // Handle connection errors
        this._minecraftManager.onError((error, guildId) => {
            logger.logError(error, `Minecraft connection error for guild: ${guildId}`);
        });

        // Message and event handlers (processed by BridgeCoordinator)
        this._minecraftManager.onMessage((messageData) => {            
            // Messages are handled by BridgeCoordinator
        });

        this._minecraftManager.onEvent((eventData) => {            
            // Events are handled by BridgeCoordinator
        });
    }

    /**
     * Setup Discord event handlers
     * 
     * Registers listeners for Discord events:
     * - Bot connection status
     * - Incoming messages
     * - Connection errors
     * 
     * @private
     */
    setupDiscordEventHandlers() {
        if (!this._discordManager) {
            return;
        }

        // Handle Discord connection status
        this._discordManager.onConnection((connectionData) => {
            if (connectionData.type === 'connected') {
                logger.discord(`Discord bot connected: ${connectionData.bot.tag}`);
            } else if (connectionData.type === 'disconnected') {
                logger.discord('Discord bot disconnected');
            }
        });
        
        // Handle Discord errors
        this._discordManager.onError((error) => {
            logger.logError(error, 'Discord connection error');
        });

        // Handle Discord messages (for Discord to Minecraft bridging)
        this._discordManager.onMessage((messageData) => {
            logger.debug(`Discord message received: ${messageData.type}`);
        });
    }

    /**
     * Finalize startup process
     * 
     * Completes initialization by:
     * - Logging startup summary with configuration details
     * - Reporting startup metrics
     * - Verifying all systems are operational
     * 
     * @async
     * @private
     * @returns {Promise}
     */
    async finalizeStartup() {
        logger.info("===========================================");
        logger.info("======= 🎯 Finalizing Startup =======");
        logger.info("===========================================");

        const stepStartTime = Date.now();

        try {
            // Log configuration summary
            this.logStartupSummary();

            // Start reporting what the bridge delivers versus what it drops. Every
            // rejection path used to log at debug only, so in production a lost message
            // left no trace and the bridge appeared to have a 100% success rate.
            const summaryInterval = this.config.get('features.metrics.summaryIntervalMs') || 15 * 60 * 1000;
            metrics.startSummary(summaryInterval);
            logger.info(`📊 Delivery metrics enabled (summary every ${Math.round(summaryInterval / 60000)} min)`);

            logger.logPerformance('Startup finalization', stepStartTime);
            logger.info('✅ Startup finalized');

        } catch (error) {
            logger.logError(error, 'Startup finalization failed');
            throw new Error(`Startup finalization failed: ${error.message}`);
        }
    }

    /**
     * Log startup summary
     * 
     * Displays configured features and active settings including:
     * - Number of guilds configured
     * - Inter-guild relay status
     * - Discord integration status
     * - Monitoring settings
     * 
     * @private
     */
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
        
        logger.info(`   • Discord integration: ${this._discordManager ? '✅' : '❌'}`);
        logger.info(`   • Monitoring enabled: ${this.config.get('advanced.performance.enablePerformanceMonitoring') ? '✅' : '❌'}`);
        logger.info(`   • Log level: ${logger.getLevel()}`);

        // List all configured guilds
        enabledGuilds.forEach(guild => {
            logger.info(`   • Guild: ${guild.name} [${guild.tag}] (${guild.server.serverName})`);
        });
    }

    /**
     * Get required directories from configuration
     * 
     * Determines all directory paths needed by the application:
     * - Data directory
     * - Logs directory
     * - Database directory
     * - Backups directory
     * - Authentication cache directories (may be different per guild)
     * 
     * @private
     * @returns {object} Map of directory types to paths
     */
    getRequiredDirectories() {
        const enabledGuilds = this.config.get("guilds").filter(guild => guild.enabled);
        let authCachePath = './data/auth-cache';
        
        // Use sessionPath from first guild as primary auth cache location
        if (enabledGuilds.length > 0) {
            const firstGuild = enabledGuilds[0];
            authCachePath = firstGuild.account.sessionPath || firstGuild.account.cachePath || authCachePath;
        }
        
        const loggingConfig = this.config.get("features.logging");
        const enabledFileLogging = loggingConfig.file;
        let logsPath = './data/logs';

        if (enabledFileLogging) {
            logsPath = loggingConfig.logFileDirectory;
        }
        
        const directories = {
            data: 'data',
            logs: logsPath,
            authCache: authCachePath
        };
        
        // Check if different guilds use different auth paths
        const uniqueAuthPaths = new Set();
        enabledGuilds.forEach(guild => {
            const sessionPath = guild.account.sessionPath || authCachePath;
            const cachePath = guild.account.cachePath || authCachePath;
            const accountAuthPath = sessionPath || cachePath;
            
            if (accountAuthPath && accountAuthPath !== authCachePath) {
                uniqueAuthPaths.add(accountAuthPath);
            }
        });
        
        // Add additional auth cache directories if guilds use different paths
        let authCacheIndex = 1;
        uniqueAuthPaths.forEach(authPath => {
            directories[`authCache${authCacheIndex++}`] = authPath;
        });
        
        return directories;
    }

    /**
     * Format uptime duration
     * 
     * Converts milliseconds to human-readable format (hours:minutes:seconds)
     * 
     * @private
     * @param {number} ms - Uptime in milliseconds
     * @returns {string} Formatted uptime string
     */
    formatUptime(ms) {
        const seconds = Math.floor((ms / 1000) % 60);
        const minutes = Math.floor((ms / (1000 * 60)) % 60);
        const hours = Math.floor(ms / (1000 * 60 * 60));
        
        return `${hours}h ${minutes}m ${seconds}s`;
    }

    /**
     * Update inter-guild configuration
     * 
     * Dynamically updates inter-guild relay settings without restart
     * 
     * @param {object} newConfig - New inter-guild configuration
     * @returns {object} Updated configuration
     */
    updateInterGuildConfig(newConfig) {
        const currentConfig = this.config.get('bridge.interGuild');
        const updatedConfig = { ...currentConfig, ...newConfig };
        
        // Update configuration and notify managers
        if (this._minecraftManager) {
            this._minecraftManager.updateInterGuildConfig(updatedConfig);
            logger.info('Inter-guild configuration updated', updatedConfig);
        }

        return updatedConfig;
    }

    /**
     * Get Minecraft manager instance
     * @returns {MinecraftManager} Minecraft manager instance
     */
    getMinecraftManager() {
        return this._minecraftManager;
    }

    /**
     * Get Discord manager instance
     * @returns {DiscordManager} Discord manager instance
     */
    getDiscordManager() {
        return this._discordManager;
    }
}

// Module-level instance tracking
let mainInstance = null;

/**
 * Main entry function
 * 
 * Creates and starts the MainBridge instance, then registers it
 * with the BridgeLocator for global access by subsystems.
 * 
 * @async
 * @returns {Promise}
 */
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

// ==================== Signal Handling ====================

/**
 * Handle SIGINT signal (Ctrl+C)
 * Initiates graceful shutdown when user presses Ctrl+C
 */
process.on('SIGINT', async () => {
    logger.info('🛑 Shutdown signal received (Ctrl+C)...');
    await handleShutdown('SIGINT');
});

/**
 * Handle SIGTERM signal
 * Initiates graceful shutdown when process receives termination signal
 */
process.on('SIGTERM', async () => {
    logger.info('🛑 Termination signal received...');
    await handleShutdown('SIGTERM');
});

/**
 * Handle shutdown signals
 * 
 * Performs graceful shutdown sequence:
 * 1. Log shutdown initiation
 * 2. Stop main bridge instance
 * 3. Exit process cleanly
 * 
 * @async
 * @param {string} signal - Signal name (SIGINT/SIGTERM)
 */
async function handleShutdown(signal) {
    try {
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

// ==================== Error Handling ====================

/**
 * Handle uncaught exceptions
 * Logs error and exits process to prevent undefined state
 */
process.on('uncaughtException', (error) => {
    logger.logError(error, 'Uncaught exception - process will exit');
    process.exit(1);
});

/**
 * Handle unhandled promise rejections
 * Logs error and exits process to prevent undefined state
 */
process.on('unhandledRejection', (reason, promise) => {
    const error = new Error(`Unhandled promise rejection: ${reason}`);
    logger.logError(error, 'Unhandled promise rejection - process will exit');
    process.exit(1);
});

// Start the application if run directly
if (require.main === module) {
    main();
}

module.exports = MainBridge;