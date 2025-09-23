// Globals Imports
const { SlashCommandBuilder } = require('discord.js');
const { readdirSync } = require('fs');
const { join } = require('path');

// Specific Imports
const logger = require('../../../shared/logger');

class GuildCommandManager {
    constructor() {
        this.subcommands = new Map();
        this.loadSubcommands();
    }

    /**
     * Load all subcommands from the guild directory
     */
    loadSubcommands() {
        try {
            const guildDir = join(__dirname, 'guild');
            const files = readdirSync(guildDir).filter(file => file.endsWith('.js'));

            for (const file of files) {
                try {
                    const subcommandPath = join(guildDir, file);
                    delete require.cache[require.resolve(subcommandPath)]; // Allow hot reloading
                    
                    const subcommand = require(subcommandPath);
                    const commandName = file.replace('.js', '');
                    
                    this.subcommands.set(commandName, subcommand);
                    logger.debug(`Loaded guild subcommand: ${commandName}`);
                    
                } catch (error) {
                    logger.logError(error, `Failed to load guild subcommand: ${file}`);
                }
            }

            logger.debug(`Loaded ${this.subcommands.size} guild subcommands`);

        } catch (error) {
            logger.logError(error, 'Failed to load guild subcommands directory');
        }
    }

    /**
     * Execute a subcommand
     * @param {string} subcommandName - Name of the subcommand
     * @param {object} interaction - Discord interaction
     * @param {object} context - Command context
     */
    async executeSubcommand(subcommandName, interaction, context) {
        const subcommand = this.subcommands.get(subcommandName);
        
        if (!subcommand || !subcommand.execute) {
            throw new Error(`Subcommand '${subcommandName}' not found or not executable`);
        }

        // Check permissions if the subcommand specifies them
        if (subcommand.permission) {
            const hasPermission = this.checkPermission(interaction.member, subcommand.permission, context);
            if (!hasPermission) {
                await interaction.reply({
                    content: `You do not have permission to use the \`${subcommandName}\` command.`,
                    ephemeral: true
                });
                return;
            }
        }

        await subcommand.execute(interaction, context);
    }

    /**
     * Check if member has required permission
     * @param {GuildMember} member - Discord guild member
     * @param {string} requiredPermission - Required permission level
     * @param {object} context - Command context
     * @returns {boolean} Has permission
     */
    checkPermission(member, requiredPermission, context) {
        if (!member || !requiredPermission) return true;

        const adminRoles = context.config.get('discord.permissions.adminRoles') || [];
        const modRoles = context.config.get('discord.permissions.moderatorRoles') || [];

        switch (requiredPermission.toLowerCase()) {
            case 'admin':
                return member.roles.cache.some(role => 
                    adminRoles.includes(role.id) || adminRoles.includes(role.name)
                ) || member.permissions.has('Administrator');
                
            case 'mod':
            case 'moderator':
                return member.roles.cache.some(role => 
                    adminRoles.includes(role.id) || adminRoles.includes(role.name) ||
                    modRoles.includes(role.id) || modRoles.includes(role.name)
                ) || member.permissions.has('Administrator') || member.permissions.has('ManageMessages');
                
            default:
                return true;
        }
    }
}

// Create singleton instance
const guildCommandManager = new GuildCommandManager();

module.exports = {
    data: new SlashCommandBuilder()
    .setName("guild")
    .setDescription("Guild management commands")
    .addSubcommand((subcommand) =>
        subcommand
            .setName("invite")
            .setDescription("Invite a player to a guild")
            .addStringOption((option) =>
            option
                .setName("guildname")
                .setDescription("Name of the guild to invite to")
                .setAutocomplete(true)
                .setRequired(true)
            )
            .addStringOption((option) =>
            option
                .setName("username")
                .setDescription("Username of the player to invite")
                .setRequired(true)
            )
    )
    .addSubcommand((subcommand) =>
        subcommand
            .setName("kick")
            .setDescription("Kick a player from a guild")
            .addStringOption((option) =>
            option
                .setName("guildname")
                .setDescription("Name of the guild to kick from")
                .setAutocomplete(true)
                .setRequired(true)
            )
            .addStringOption((option) =>
            option
                .setName("username")
                .setDescription("Username of the player to kick")
                .setRequired(true)
            )
            .addStringOption((option) =>
            option
                .setName("reason")
                .setDescription("Reason for kicking the player")
                .setRequired(true)
            )
    )
    .addSubcommand((subcommand) =>
        subcommand
            .setName("promote")
            .setDescription("Promote a player in a guild")
            .addStringOption((option) =>
            option
                .setName("guildname")
                .setDescription("Name of the guild")
                .setAutocomplete(true)
                .setRequired(true)
            )
            .addStringOption((option) =>
            option
                .setName("username")
                .setDescription("Username of the player to promote")
                .setRequired(true)
            )
    )
    .addSubcommand((subcommand) =>
        subcommand
            .setName("demote")
            .setDescription("Demote a player in a guild")
            .addStringOption((option) =>
            option
                .setName("guildname")
                .setDescription("Name of the guild")
                .setAutocomplete(true)
                .setRequired(true)
            )
            .addStringOption((option) =>
            option
                .setName("username")
                .setDescription("Username of the player to demote")
                .setRequired(true)
            )
    )
    .addSubcommand((subcommand) =>
        subcommand
            .setName("setrank")
            .setDescription("Set a player rank in the guild")
            .addStringOption((option) =>
            option
                .setName("guildname")
                .setDescription("Name of the guild")
                .setAutocomplete(true)
                .setRequired(true)
            )
            .addStringOption((option) =>
            option
                .setName("username")
                .setDescription("Username of the player")
                .setRequired(true)
            )
            .addStringOption((option) =>
            option
                .setName("rank")
                .setDescription("Rank to set (case-insensitive)")
                .setRequired(true)
            )
    ),
    
    permission: 'user', // Base permission, subcommands can override
    
    async execute(interaction, context) {
        const subcommandName = interaction.options.getSubcommand();
        
        try {
            await guildCommandManager.executeSubcommand(subcommandName, interaction, context);
            
        } catch (error) {
            logger.logError(error, `Error executing guild subcommand: ${subcommandName}`);
            
            const errorMessage = `An error occurred while executing the \`${subcommandName}\` command.`;
            
            if (interaction.replied || interaction.deferred) {
                await interaction.followUp({ content: errorMessage, ephemeral: true });
            } else {
                await interaction.reply({ content: errorMessage, ephemeral: true });
            }
        }
    },
};