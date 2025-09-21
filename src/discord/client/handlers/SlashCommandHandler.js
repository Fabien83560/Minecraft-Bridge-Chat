// Globals Imports
const { Collection, Events, REST, Routes } = require('discord.js');
const { readdirSync, statSync } = require('fs');
const { join } = require('path');
const EventEmitter = require('events');

// Specific Imports
const BridgeLocator = require("../../../bridgeLocator.js");
const logger = require("../../../shared/logger");

class SlashCommandHandler extends EventEmitter {
    constructor() {
        super();

        const mainBridge = BridgeLocator.getInstance();
        this.config = mainBridge.config;

        this.client = null;
        this.commands = new Collection();
        this.commandsData = [];
        
        // Admin and mod roles for permission checking
        this.adminRoles = this.config.get('bridge.adminRoles') || [];
        this.modRoles = this.config.get('bridge.modRoles') || [];
        
        // Statistics
        this.stats = {
            commandsLoaded: 0,
            commandsExecuted: 0,
            errors: 0
        };

        logger.debug('SlashCommandHandler initialized');
    }

    /**
     * Initialize with Discord client
     * @param {Client} client - Discord client instance
     */
    async initialize(client) {
        if (!client) {
            throw new Error('Discord client is required for SlashCommandHandler initialization');
        }

        this.client = client;

        try {
            // Load all commands from the commands directory and subdirectories
            await this.loadCommands();
            
            // Register slash commands with Discord
            await this.registerCommands();
            
            // Setup interaction listener
            this.setupInteractionListener();

            logger.discord(`SlashCommandHandler initialized with ${this.commands.size} commands`);

        } catch (error) {
            logger.logError(error, 'Failed to initialize SlashCommandHandler');
            throw error;
        }
    }

    /**
     * Load all commands from the commands directory and subdirectories
     */
    async loadCommands() {
        const commandsPath = join(__dirname, '../commands');
        
        try {
            await this.loadCommandsFromDirectory(commandsPath);
            logger.discord(`Loaded ${this.stats.commandsLoaded} slash commands`);

        } catch (error) {
            if (error.code === 'ENOENT') {
                logger.warn('Commands directory not found, creating it...');
                const fs = require('fs');
                fs.mkdirSync(commandsPath, { recursive: true });
            } else {
                logger.logError(error, 'Failed to load commands directory');
            }
        }
    }

    /**
     * Recursively load commands from a directory
     * @param {string} dirPath - Directory path to scan
     * @param {boolean} isSubdirectory - Whether this is a subdirectory (default: false)
     */
    async loadCommandsFromDirectory(dirPath, isSubdirectory = false) {
        try {
            const items = readdirSync(dirPath);

            for (const item of items) {
                const itemPath = join(dirPath, item);
                const itemStats = statSync(itemPath);

                if (itemStats.isDirectory()) {
                    // Skip subdirectories for command loading
                    // Subdirectories contain subcommand modules, not full commands
                    logger.debug(`Skipping subdirectory: ${item} (contains subcommand modules)`);
                    continue;
                } else if (item.endsWith('.js')) {
                    // Only load command files from the main commands directory
                    if (!isSubdirectory) {
                        await this.loadCommandFile(itemPath, item);
                    }
                }
            }
        } catch (error) {
            logger.logError(error, `Failed to load commands from directory: ${dirPath}`);
        }
    }

    /**
     * Load a single command file
     * @param {string} filePath - Path to the command file
     * @param {string} fileName - Name of the file
     */
    async loadCommandFile(filePath, fileName) {
        try {
            // Clear require cache to allow hot reloading
            delete require.cache[require.resolve(filePath)];
            
            const command = require(filePath);
            
            // Validate command structure
            if (!command.data || !command.execute) {
                logger.debug(`Skipping ${fileName} - not a complete slash command (likely a subcommand module)`);
                return;
            }

            // Store command
            this.commands.set(command.data.name, command);
            this.commandsData.push(command.data.toJSON());
            
            this.stats.commandsLoaded++;
            logger.discord(`Loaded slash command: ${command.data.name} from ${fileName}`);
            
        } catch (error) {
            logger.logError(error, `Failed to load command file: ${fileName}`);
        }
    }

    /**
     * Register slash commands with Discord API
     */
    async registerCommands() {
        if (this.commandsData.length === 0) {
            logger.warn('No slash commands to register');
            return;
        }

        try {
            const rest = new REST().setToken(this.config.get('app.token'));
            const clientId = this.config.get('app.clientId');

            if (!clientId) {
                throw new Error('Discord client ID not found in configuration');
            }

            logger.debug('Started refreshing application (/) commands...');

            // Register commands globally
            await rest.put(
                Routes.applicationCommands(clientId),
                { body: this.commandsData }
            );

            logger.discord(`Successfully registered ${this.commandsData.length} slash commands globally`);

        } catch (error) {
            logger.logError(error, 'Failed to register slash commands');
            throw error;
        }
    }

    /**
     * Setup interaction listener for slash commands
     */
    setupInteractionListener() {
        this.client.on(Events.InteractionCreate, async (interaction) => {
            if (!interaction.isChatInputCommand()) return;

            const command = this.commands.get(interaction.commandName);

            if (!command) {
                logger.warn(`No command matching ${interaction.commandName} was found`);
                return;
            }

            try {
                this.stats.commandsExecuted++;

                // Check permissions if required
                if (command.permission && !this.hasPermission(interaction.member, command.permission)) {
                    await interaction.reply({
                        content: 'You do not have permission to use this command.',
                        ephemeral: true
                    });
                    return;
                }

                // Execute command with full context
                await command.execute(interaction, {
                    client: this.client,
                    config: this.config,
                    bridgeLocator: BridgeLocator.getInstance()
                });
                
                logger.discord(`Executed slash command: ${interaction.commandName} by ${interaction.user.displayName}`);

            } catch (error) {
                this.stats.errors++;
                logger.logError(error, `Error executing slash command: ${interaction.commandName}`);

                const errorMessage = 'There was an error while executing this command!';
                
                try {
                    if (interaction.replied || interaction.deferred) {
                        await interaction.followUp({ content: errorMessage, ephemeral: true });
                    } else {
                        await interaction.reply({ content: errorMessage, ephemeral: true });
                    }
                } catch (replyError) {
                    logger.logError(replyError, 'Failed to send error message to user');
                }
            }
        });
    }

    /**
     * Check if member has required permission
     * @param {GuildMember} member - Discord guild member
     * @param {string} requiredPermission - Required permission level
     * @returns {boolean} Has permission
     */
    hasPermission(member, requiredPermission) {
        if (!member || !requiredPermission) return true;

        switch (requiredPermission.toLowerCase()) {
            case 'admin':
                return member.roles.cache.some(role => 
                    this.adminRoles.includes(role.id) || this.adminRoles.includes(role.name)
                ) || member.permissions.has('Administrator');
                
            case 'mod':
            case 'moderator':
                return member.roles.cache.some(role => 
                    this.adminRoles.includes(role.id) || this.adminRoles.includes(role.name) ||
                    this.modRoles.includes(role.id) || this.modRoles.includes(role.name)
                ) || member.permissions.has('Administrator') || member.permissions.has('ManageMessages');
                
            default:
                return true;
        }
    }

    /**
     * Reload all commands
     */
    async reloadCommands() {
        try {
            this.commands.clear();
            this.commandsData = [];
            this.stats.commandsLoaded = 0;

            await this.loadCommands();
            await this.registerCommands();

            logger.discord('Slash commands reloaded successfully');
            return { success: true, count: this.commands.size };

        } catch (error) {
            logger.logError(error, 'Failed to reload slash commands');
            return { success: false, error: error.message };
        }
    }

    /**
     * Get statistics
     * @returns {object} Handler statistics
     */
    getStatistics() {
        return {
            ...this.stats,
            commandsRegistered: this.commands.size
        };
    }

    /**
     * Cleanup resources
     */
    cleanup() {
        this.commands.clear();
        this.commandsData = [];
        this.client = null;
        
        // Remove all listeners
        this.removeAllListeners();

        logger.debug('SlashCommandHandler cleaned up');
    }
}

module.exports = SlashCommandHandler;