// Globals Imports
const { EmbedBuilder } = require('discord.js');

// Specific Imports
const logger = require('../../../../shared/logger');

/**
 * Create success response embed
 * @param {string} guildName - Guild name
 * @param {string} command - Command that was executed
 * @returns {EmbedBuilder} Success embed
 */
function createSuccessEmbed(guildName, command) {
    return new EmbedBuilder()
        .setTitle('✅ Command Sent Successfully')
        .setDescription(`Command has been sent to guild \`${guildName}\``)
        .setColor(0x00FF00)
        .addFields(
            { name: '🏰 Guild', value: guildName, inline: true },
            { name: '📝 Command', value: `\`${command}\``, inline: false }
        )
        .setFooter({ text: 'Note: This only confirms the command was sent, not the game response.' })
        .setTimestamp();
}

/**
 * Create error response embed
 * @param {string} guildName - Guild name
 * @param {string} command - Command that failed
 * @param {string} errorMessage - Error message
 * @returns {EmbedBuilder} Error embed
 */
function createErrorEmbed(guildName, command, errorMessage) {
    return new EmbedBuilder()
        .setTitle('❌ Command Execution Failed')
        .setDescription(`Failed to send command to guild \`${guildName}\``)
        .setColor(0xFF0000)
        .addFields(
            { name: '🏰 Guild', value: guildName, inline: true },
            { name: '📝 Command', value: `\`${command}\``, inline: false },
            { name: '🚫 Error', value: errorMessage || 'Unknown error occurred', inline: false }
        )
        .setTimestamp();
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

module.exports = {
    permission: 'admin',

    async execute(interaction, context) {
        await interaction.deferReply();
        await handleExecuteCommand(interaction, context);
    }
};

async function handleExecuteCommand(interaction, context) {
    const guildName = interaction.options.getString('guildname');
    const commandToExecute = interaction.options.getString('command_to_execute');
    
    try {
        logger.discord(`[GUILD-EXECUTE] Processing execute command: ${guildName} -> ${commandToExecute}`);
        
        // Get Minecraft manager
        const minecraftManager = context.bridgeLocator.getMinecraftManager?.();
        if (!minecraftManager) {
            await interaction.editReply({
                content: '❌ Minecraft manager not available. Please try again later.'
            });
            return;
        }

        // Find guild configuration
        const guildConfig = findGuildByName(context.config, guildName);
        if (!guildConfig) {
            await interaction.editReply({
                content: `❌ Guild \`${guildName}\` not found. Available guilds: ${getAvailableGuilds(context.config).join(', ')}`
            });
            return;
        }

        // Get bot manager and check connection
        const botManager = minecraftManager._botManager;
        if (!botManager || !botManager.isGuildConnected(guildConfig.id)) {
            await interaction.editReply({
                content: `❌ Guild \`${guildName}\` is not currently connected to Minecraft.`
            });
            return;
        }

        // Check if user accidentally included /g or /guild prefix
        if (commandToExecute.startsWith('/g ') || commandToExecute.startsWith('/guild ')) {
            await interaction.editReply({
                content: '❌ Do not include `/g` or `/guild` prefix in the command. Just provide the command itself.'
            });
            return;
        }

        // Format the final command
        const finalCommand = `/g ${commandToExecute}`;
        
        try {
            // Execute the command
            await botManager.executeCommand(guildConfig.id, finalCommand);
            
            logger.discord(`[GUILD-EXECUTE] Command sent to ${guildName}: ${finalCommand}`);
            
            // Create and send success response
            const successEmbed = createSuccessEmbed(guildName, finalCommand);
            await interaction.editReply({ embeds: [successEmbed] });

        } catch (commandError) {
            logger.logError(commandError, `[GUILD-EXECUTE] Failed to execute command: ${finalCommand}`);
            
            // Create and send error response
            const errorEmbed = createErrorEmbed(guildName, finalCommand, commandError.message);
            await interaction.editReply({ embeds: [errorEmbed] });
        }

    } catch (error) {
        logger.logError(error, `[GUILD-EXECUTE] Unexpected error processing execute command`);
        
        const errorEmbed = new EmbedBuilder()
            .setTitle('❌ Unexpected Error')
            .setDescription('An unexpected error occurred while processing the execute command.')
            .setColor(0xFF0000)
            .setTimestamp();
        
        await interaction.editReply({ embeds: [errorEmbed] });
    }
}