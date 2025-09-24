// Globals Imports
const { EmbedBuilder } = require('discord.js');

// Specific Imports
const CommandResponseListener = require('../../handlers/CommandResponseListener.js');
const logger = require('../../../../shared/logger');

// Singleton instance for command response listener
let commandResponseListener = null;

function getCommandResponseListener() {
    if (!commandResponseListener) {
        commandResponseListener = new CommandResponseListener();
    }
    return commandResponseListener;
}

module.exports = {
    permission: 'moderator',
    
    async execute(interaction, context) {
        // Defer the reply since this might take some time
        await interaction.deferReply();
        
        await handleKickCommand(interaction, context);
    },
};

/**
 * Handle the guild kick command
 * @param {ChatInputCommandInteraction} interaction - Discord interaction
 * @param {object} context - Command context with client, config, etc.
 */
async function handleKickCommand(interaction, context) {
    const guildName = interaction.options.getString('guildname');
    const username = interaction.options.getString('username');
    const reason = interaction.options.getString('reason') || 'No reason provided';
    
    try {
        logger.discord(`[GUILD-KICK] Processing kick command: ${guildName} -> ${username} (Reason: ${reason})`);

        // Get Minecraft manager
        const minecraftManager = context.bridgeLocator.getMinecraftManager?.();
        if (!minecraftManager) {
            await interaction.editReply({
                content: '❌ Minecraft manager not available. Please try again later.',
                ephemeral: true
            });
            return;
        }

        // Find guild configuration by name
        const guildConfig = findGuildByName(context.config, guildName);
        if (!guildConfig) {
            await interaction.editReply({
                content: `❌ Guild \`${guildName}\` not found. Available guilds: ${getAvailableGuilds(context.config).join(', ')}`,
                ephemeral: true
            });
            return;
        }

        // Check if guild is connected
        const botManager = minecraftManager._botManager;
        if (!botManager || !botManager.isGuildConnected(guildConfig.id)) {
            await interaction.editReply({
                content: `❌ Guild \`${guildName}\` is not currently connected to Minecraft.`,
                ephemeral: true
            });
            return;
        }

        // Validate username format
        if (!isValidMinecraftUsername(username)) {
            await interaction.editReply({
                content: `❌ Invalid username format: \`${username}\`. Minecraft usernames must be 3-16 characters long and contain only letters, numbers, and underscores.`,
                ephemeral: true
            });
            return;
        }

        const command = `/g kick ${username} ${reason}`;

        // Set up command response listener
        const responseListener = getCommandResponseListener();
        const listenerId = responseListener.createListener(
            guildConfig.id,
            'kick',
            username,
            command,
            15000,
            interaction
        );

        // Send initial response
        const initialEmbed = new EmbedBuilder()
            .setTitle('🔄 Processing Guild Kick')
            .setDescription(`Kicking \`${username}\` from guild \`${guildName}\`...`)
            .setColor(0xFFA500) // Orange color for "in progress"
            .addFields(
                { name: '👤 Player', value: username, inline: true },
                { name: '🏰 Guild', value: guildName, inline: true },
                { name: '📝 Reason', value: reason, inline: false },
                { name: '⏱️ Status', value: 'Sending kick command...', inline: false }
            )
            .setTimestamp();

        await interaction.editReply({ embeds: [initialEmbed] });

        try {
            await botManager.executeCommand(guildConfig.id, command);
            
            logger.discord(`[GUILD-KICK] Command sent to ${guildName}: ${command}`);

            // Wait for response
            const result = await responseListener.waitForResult(listenerId);
            
            // Create response embed based on result
            const responseEmbed = createResponseEmbed(guildName, username, reason, result);
            await interaction.editReply({ embeds: [responseEmbed] });

            // Log the result
            if (result.success) {
                logger.discord(`[GUILD-KICK] ✅ Successfully kicked ${username} from ${guildName}`);
            } else {
                logger.discord(`[GUILD-KICK] ❌ Failed to kick ${username} from ${guildName}: ${result.error}`);
            }

        } catch (commandError) {
            logger.logError(commandError, `[GUILD-KICK] Failed to execute kick command`);
            
            // Cancel the listener since command execution failed
            responseListener.cancelListener(listenerId);
            
            const errorEmbed = new EmbedBuilder()
                .setTitle('❌ Command Execution Failed')
                .setDescription(`Failed to execute kick command for \`${username}\``)
                .setColor(0xFF0000) // Red color for error
                .addFields(
                    { name: '👤 Player', value: username, inline: true },
                    { name: '🏰 Guild', value: guildName, inline: true },
                    { name: '📝 Reason', value: reason, inline: false },
                    { name: '🚫 Error', value: commandError.message || 'Unknown error occurred', inline: false }
                )
                .setTimestamp();

            await interaction.editReply({ embeds: [errorEmbed] });
        }

    } catch (error) {
        logger.logError(error, `[GUILD-KICK] Unexpected error processing kick command`);
        
        const errorEmbed = new EmbedBuilder()
            .setTitle('❌ Unexpected Error')
            .setDescription('An unexpected error occurred while processing the kick command.')
            .setColor(0xFF0000)
            .addFields(
                { name: '🚫 Error', value: error.message || 'Unknown error', inline: false }
            )
            .setTimestamp();

        await interaction.editReply({ embeds: [errorEmbed] });
    }
}

/**
 * Find guild configuration by name
 * @param {object} config - Configuration object
 * @param {string} guildName - Guild name to search for
 * @returns {object|null} Guild configuration or null if not found
 */
function findGuildByName(config, guildName) {
    const guilds = config.get('guilds') || [];
    return guilds.find(guild => 
        guild.name.toLowerCase() === guildName.toLowerCase() && guild.enabled
    );
}

/**
 * Get list of available guild names
 * @param {object} config - Configuration object
 * @returns {string[]} Array of guild names
 */
function getAvailableGuilds(config) {
    const guilds = config.get('guilds') || [];
    return guilds
        .filter(guild => guild.enabled)
        .map(guild => guild.name);
}

/**
 * Validate Minecraft username format
 * @param {string} username - Username to validate
 * @returns {boolean} True if valid
 */
function isValidMinecraftUsername(username) {
    // Minecraft usernames: 3-16 characters, letters, numbers, underscores
    const minecraftUsernameRegex = /^[a-zA-Z0-9_]{3,16}$/;
    return minecraftUsernameRegex.test(username);
}

/**
 * Create response embed based on command result
 * @param {string} guildName - Guild name
 * @param {string} username - Player username
 * @param {string} reason - Kick reason
 * @param {object} result - Command result
 * @returns {EmbedBuilder} Response embed
 */
function createResponseEmbed(guildName, username, reason, result) {
    const embed = new EmbedBuilder()
        .addFields(
            { name: '👤 Player', value: username, inline: true },
            { name: '🏰 Guild', value: guildName, inline: true },
            { name: '📝 Reason', value: reason, inline: false }
        )
        .setTimestamp();

    if (result.success) {
        embed
            .setTitle('✅ Guild Kick Successful')
            .setDescription(`Successfully kicked \`${username}\` from guild \`${guildName}\`!`)
            .setColor(0x00FF00) // Green color for success
            .addFields(
                { name: '📝 Response', value: result.message || 'Player kicked successfully', inline: false }
            );
    } else {
        let title, description, color;

        switch (result.type) {
            case 'timeout':
                title = '⏰ Command Timeout';
                description = `No response received from Minecraft within 15 seconds.`;
                color = 0xFFA500; // Orange
                break;
            case 'command_error':
                title = '❌ Kick Failed';
                description = `Failed to kick \`${username}\` from guild \`${guildName}\`.`;
                color = 0xFF0000; // Red
                break;
            case 'system_error':
                title = '🔧 System Error';
                description = `A system error occurred while processing the kick.`;
                color = 0xFF0000; // Red
                break;
            case 'cancelled':
                title = '🚫 Command Cancelled';
                description = `The kick command was cancelled.`;
                color = 0x808080; // Gray
                break;
            default:
                title = '❌ Unknown Error';
                description = `An unknown error occurred.`;
                color = 0xFF0000; // Red
        }

        embed
            .setTitle(title)
            .setDescription(description)
            .setColor(color)
            .addFields(
                { name: '🚫 Error', value: result.error || 'Unknown error', inline: false }
            );
    }

    return embed;
}