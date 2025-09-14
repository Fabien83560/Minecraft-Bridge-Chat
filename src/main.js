// Globals Imports
const fs = require('fs');
const path = require('path');

// Specific Imports
const logger = require('./shared/logger');
const Config = require("../config/index.js")

class MainBridge {
    constructor() {
        logger.info("=====================================")
        logger.info("======= Initialize MainBridge =======")
        logger.info("=====================================")

        this._startTime = Date.now();
        this._isRunning = false;

        this.config = new Config();
    }

    async start() {
        logger.info("=====================================")
        logger.info("====== 🚀 Starting Application ======")
        logger.info("=====================================")

        // Step 1 : Initialize core systems
        await this.initializeCoreSystems();
    }

    async stop() {
        
    }

    async initializeCoreSystems() {
        logger.info("=====================================")
        logger.info("=== ⚙️  Initializing core systems  ===");
        logger.info("=====================================")

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

    getRequiredDirectories() {
        // Get auth cache path from first enabled guild account
        const enabledGuilds = this.config.get("guilds").filter(guild => guild.enabled);;
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
}

let instance = null;

async function main() {
    try {
        instance = new MainBridge();
        await instance.start();
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
        if (bridgeInstance) {
            await bridgeInstance.stop();
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