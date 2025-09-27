// Command Detection Handler - Detects slash-like commands from messages
const { Events } = require('discord.js');
const logger = require('../../../shared/logger');
const BridgeLocator = require('../../../bridgeLocator.js');

class CommandDetectionHandler {
    constructor() {
        const mainBridge = BridgeLocator.getInstance();
        this.config = mainBridge.config;

        this.client = null;
        this.commands = new Map(); // Store available commands
        this.detectionChannelId = null;
        this.allowedUserIds = null;
        this.commandPrefix = '/'; // Prefix for detected commands
    }

    /**
     * Initialize the handler with Discord client
     */
    async initialize(client) {
        this.client = client;
        this.detectionChannelId = this.config.get('features.detection.channelId'); // Channel to monitor
        this.allowedUserIds = this.config.get('features.detection.allowedUsers') || []; // Whitelist of user IDs

        this.setupMessageListener();
        logger.debug('Command Detection Handler initialized');
    }

    /**
     * Register available commands from slash command handler
     */
    registerCommands(slashCommands) {
        this.commands = new Map(slashCommands);
        logger.debug(`Registered ${this.commands.size} commands for detection`);
    }

    /**
     * Setup message listener for command detection
     */
    setupMessageListener() {
        this.client.on(Events.MessageCreate, async (message) => {
            try {
                await this.handleMessage(message);
            } catch (error) {
                logger.logError(error, 'Error in command detection handler');
            }
        });
    }

    /**
     * Handle incoming messages and detect commands
     */
    async handleMessage(message) {
        // Skip if not in detection channel
        if (message.channel.id !== this.detectionChannelId) {
            return;
        }

        // Skip if message is from this user (prevent loops)
        if (message.author.id === this.client.user.id) {
            return;
        }

        // Check if message is from an allowed user
        if (!this.allowedUserIds.includes(message.author.id)) {
            logger.warn(`Unauthorized user attempted command: ${message.author.tag} (${message.author.id})`);
            return;
        }

        // Check if message looks like a command
        if (!message.content.startsWith(this.commandPrefix)) {
            return;
        }

        await this.processDetectedCommand(message);
    }

    /**
     * Process detected command from message
     */
    async processDetectedCommand(message) {
        try {
            const parsedCommand = this.parseCommand(message.content);
            
            if (!parsedCommand) {
                logger.warn(`Failed to parse command: ${message.content}`);
                await message.react('❌');
                return;
            }

            const { commandName, options } = parsedCommand;
            
            // Check if command exists
            const command = this.commands.get(commandName);
            if (!command) {
                logger.warn(`Unknown command detected: ${commandName}`);
                await message.react('❓');
                return;
            }

            // Create pseudo-interaction object
            const pseudoInteraction = this.createPseudoInteraction(message, commandName, options);
            
            // Execute the command
            logger.discord(`Executing detected command: ${commandName} from user ${message.author.tag}`);
            
            // This calls the same command.execute() function as slash commands
            await command.execute(pseudoInteraction, {
                client: this.client,
                config: this.config,
                bridgeLocator: BridgeLocator.getInstance()
            });

            // React with success
            await message.react('✅');

        } catch (error) {
            logger.logError(error, `Error executing detected command: ${message.content}`);
            await message.react('⚠️');
            
            // Send error message
            await message.reply({
                content: `Error executing command: ${error.message}`,
                allowedMentions: { repliedUser: false }
            });
        }
    }

    /**
     * Parse command string into command name and options
     * Example: "/guild promote FrenchLegacyIII Panda_Sauvage" 
     * Returns: { commandName: "guild", options: { subcommand: "promote", guildname: "FrenchLegacyIII", username: "Panda_Sauvage" } }
     * Or: { commandName: "guild", error: "Error message" } for parsing errors
     */
    parseCommand(content) {
        const parts = content.trim().split(/\s+/);
        
        if (parts.length < 2) {
            return { error: '❌ Command too short. Please provide at least a command and one parameter.' };
        }

        const commandName = parts[0].substring(1); // Remove the '/' prefix
        const args = parts.slice(1);

        // Handle different command structures
        if (commandName === 'guild') {
            const result = this.parseGuildCommand(commandName, args);
            // If parsing returned error, pass it through
            if (result.error) {
                return result;
            }
            // Ensure we have valid options
            if (!result.options || typeof result.options !== 'object') {
                return { error: '❌ Failed to parse guild command options.' };
            }
            return result;
        } else if (commandName === 'ping') {
            return { commandName, options: {} };
        }
        
        // Add more command parsers as needed
        return { commandName, options: this.parseGenericCommand(args) };
    }

    /**
     * Parse guild-specific commands
     */
    parseGuildCommand(commandName, args) {
        if (args.length < 2) {
            return {
                commandName,
                error: 'Guild command requires at least: /guild <action> <guildname>'
            };
        }

        const subcommand = args[0].toLowerCase(); // promote, demote, invite, execute, etc.
        const guildname = args[1];
        
        // Different subcommands have different parameter structures
        const options = {
            subcommand,
            guildname
        };

        switch (subcommand) {
            case 'promote':
            case 'demote':
            case 'invite':
            case 'kick':
                // These require username: /guild <action> <guildname> <username>
                if (args.length < 3) {
                    return {
                        commandName,
                        error: `Guild ${subcommand} requires: /guild ${subcommand} <guildname> <username>`
                    };
                }
                options.username = args[2];
                if (args[3]) options.rank = args[3]; // Optional rank for some commands
                break;
                
            case 'mute':
            case 'unmute':
                // Mute/unmute: /guild <action> <guildname> <scope> [username] [time]
                if (args.length < 3) {
                    return {
                        commandName,
                        error: `Guild ${subcommand} requires: /guild ${subcommand} <guildname> <scope>`
                    };
                }
                options.scope = args[2]; // 'global' or 'player'
                if (args[3]) options.username = args[3];
                if (args[4]) options.time = args[4];
                break;
            
            case 'setrank':
                // These commands have their specific parsing but are allowed
                if (subcommand === 'setrank' && args.length < 4) {
                    return {
                        commandName,
                        error: 'Guild setrank requires: /guild setrank <guildname> <username> <rank>'
                    };
                }
                if (args.length >= 3) options.username = args[2];
                if (args.length >= 4) options.rank = args[3];
                break;
                
            default:
                return {
                    commandName,
                    error: `❌ Subcommand '${subcommand}' is not authorized for remote execution.\n**Allowed commands:** promote, demote, invite, kick, execute, mute, unmute, info, list, online, setrank.`
                };
        }

        return {
            commandName,
            options
        };
    }

    /**
     * Parse generic commands (fallback)
     */
    parseGenericCommand(args) {
        const options = {};
        
        // Simple key-value parsing for other commands
        for (let i = 0; i < args.length; i += 2) {
            if (i + 1 < args.length) {
                options[args[i]] = args[i + 1];
            }
        }
        
        return options;
    }

    /**
     * Create pseudo-interaction object that mimics Discord.js ChatInputCommandInteraction
     */
    createPseudoInteraction(message, commandName, options) {
        // Ensure options is never undefined
        if (!options || typeof options !== 'object') {
            options = {};
        }

        const pseudoInteraction = {
            // Basic properties
            commandName,
            user: message.author,
            member: message.member,
            channel: message.channel,
            guild: message.guild,
            createdTimestamp: message.createdTimestamp,
            
            // State tracking
            replied: false,
            deferred: false,
            ephemeral: false,
            
            // Options handling with null safety - return empty string instead of null
            options: {
                getString: (name) => {
                    // Extra safety check
                    if (!options || typeof options !== 'object') return '';
                    const value = options[name];
                    // Return empty string instead of null to prevent startsWith errors
                    if (value === null || value === undefined) return '';
                    return String(value);
                },
                getInteger: (name) => {
                    if (!options || typeof options !== 'object') return null;
                    const value = options[name];
                    if (value === null || value === undefined) return null;
                    const parsed = parseInt(value);
                    return isNaN(parsed) ? null : parsed;
                },
                getBoolean: (name) => {
                    if (!options || typeof options !== 'object') return null;
                    const value = options[name];
                    if (value === null || value === undefined) return null;
                    if (value === 'true' || value === true) return true;
                    if (value === 'false' || value === false) return false;
                    return null;
                },
                getSubcommand: () => {
                    if (!options || typeof options !== 'object') return '';
                    return options.subcommand || '';
                }
            },
            
            // Response methods
            reply: async (responseData) => {
                pseudoInteraction.replied = true;
                
                const replyContent = typeof responseData === 'string' ? 
                    responseData : responseData.content;
                
                const embedData = responseData.embeds ? { embeds: responseData.embeds } : {};
                
                pseudoInteraction.lastReply = await message.reply({
                    content: replyContent,
                    ...embedData,
                    allowedMentions: { repliedUser: false }
                });
                
                return pseudoInteraction.lastReply;
            },
            
            editReply: async (responseData) => {
                if (!pseudoInteraction.lastReply) {
                    throw new Error('No reply to edit');
                }
                
                const editContent = typeof responseData === 'string' ? 
                    responseData : responseData.content;
                
                const embedData = responseData.embeds ? { embeds: responseData.embeds } : {};
                
                return await pseudoInteraction.lastReply.edit({
                    content: editContent,
                    ...embedData
                });
            },
            
            followUp: async (responseData) => {
                const followUpContent = typeof responseData === 'string' ? 
                    responseData : responseData.content;
                
                const embedData = responseData.embeds ? { embeds: responseData.embeds } : {};
                
                return await message.channel.send({
                    content: followUpContent,
                    ...embedData
                });
            },
            
            deferReply: async (options = {}) => {
                pseudoInteraction.deferred = true;
                pseudoInteraction.ephemeral = options.ephemeral || false;
                
                // Send a temporary "thinking" message
                pseudoInteraction.lastReply = await message.reply({
                    content: '⏳ Processing command...',
                    allowedMentions: { repliedUser: false }
                });
            },
            
            fetchReply: async () => {
                return pseudoInteraction.lastReply;
            }
        };

        return pseudoInteraction;
    }

    /**
     * Set allowed users for security
     */
    setAllowedUsers(userIds) {
        this.allowedUserIds = userIds;
        logger.debug(`Updated allowed users: ${userIds.join(', ')}`);
    }

    /**
     * Add a single allowed user
     */
    addAllowedUser(userId) {
        if (!this.allowedUserIds.includes(userId)) {
            this.allowedUserIds.push(userId);
            logger.debug(`Added allowed user: ${userId}`);
        }
    }

    /**
     * Remove an allowed bot
     */
    removeAllowedUser(userId) {
        this.allowedUserIds = this.allowedUserIds.filter(id => id !== userId);
        logger.debug(`Removed allowed user: ${userId}`);
    }
}

module.exports = CommandDetectionHandler;