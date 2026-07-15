/**
 * Guild Kick Subcommand - Player Removal from Guild
 * 
 * This subcommand handles removing (kicking) players from a Minecraft guild with a
 * specified reason. It sends the kick command to the Minecraft bot, tracks the response
 * through CommandResponseListener, and provides real-time feedback to Discord users
 * through rich embeds showing the kick status, reason, and results.
 * 
 * Command Features:
 * - Remove player from guild with mandatory reason
 * - Real-time status updates through embed messages
 * - Response tracking with 15-second timeout
 * - Comprehensive error handling and validation
 * - Guild and connection validation
 * - Username format validation (Minecraft standards)
 * - Visual feedback with color-coded embeds
 * - Reason display in embeds for transparency and audit
 * - Multiple error type handling (timeout, command error, system error, cancelled)
 * - Command execution logging for audit trail
 * 
 * Validation Checks:
 * - Minecraft manager availability
 * - Guild existence and enabled status
 * - Guild connection status (bot must be online)
 * - Username format (3-16 alphanumeric characters with underscores)
 * 
 * Response Types:
 * - Success: Green embed with confirmation message
 * - Command Error: Red embed with error details from Minecraft
 * - Timeout: Orange embed indicating no response within 15s
 * - System Error: Red embed for system-level failures
 * - Cancelled: Gray embed for cancelled operations
 * - Unknown Error: Red embed for unidentified failures
 * 
 * Embed Stages:
 * 1. Initial: Orange processing embed showing player, guild, reason, and status
 * 2. Final: Color-coded result embed based on command outcome with reason included
 * 
 * Integration:
 * - CommandResponseListener: Tracks Minecraft chat for kick confirmation/rejection
 * - BotManager: Executes guild commands in Minecraft
 * - Logger: Records all operations for debugging and audit
 * 
 * Usage: /guild kick <guildname> <username> <reason>
 * Permission: Moderator (requires moderator role)
 * Response: Ephemeral (only visible to command executor)
 * 
 * Example:
 * /guild kick FrenchLegacy Panda_Sauvage Inactivity for 30+ days
 * Result: Kicks Panda_Sauvage from FrenchLegacy with reason logged
 * 
 * Possible Outcomes:
 * - Success: Player is removed from guild, reason logged in guild logs
 * - Not in guild: Error message indicating player is not a member
 * - Insufficient permissions: Error if executor lacks kick permission
 * - Player not found: Error if player doesn't exist
 * - Timeout: No response from Minecraft within 15 seconds
 * 
 * Reason Parameter:
 * The reason is mandatory and serves multiple purposes:
 * - Provides transparency for why the player was removed
 * - Creates audit trail in Minecraft guild logs
 * - Helps with future appeal or reinvite decisions
 * - Shows in guild activity logs
 * 
 * @author Fabien83560
 * @version 1.0.0
 * @license ISC
 */

// Globals Imports
const { EmbedBuilder } = require('discord.js');

// Specific Imports
const CommandResponseListener = require('../../handlers/CommandResponseListener.js');
const kickReasonStore = require('../../../../shared/KickReasonStore.js');
const logger = require('../../../../shared/logger');

/**
 * Command response listener singleton instance
 * Cached to avoid creating multiple instances
 * @type {CommandResponseListener|null}
 */
let commandResponseListener = null;

/**
 * Get or create CommandResponseListener singleton
 * 
 * Returns the existing singleton instance or creates a new one if needed.
 * Ensures only one listener instance exists throughout the application.
 * 
 * @returns {CommandResponseListener} Singleton instance
 */
function getCommandResponseListener() {
    if (!commandResponseListener) {
        commandResponseListener = new CommandResponseListener();
    }
    return commandResponseListener;
}

/**
 * Kick Subcommand Module
 * 
 * Exports configuration and execution function for the kick subcommand.
 * 
 * @module guild/kick
 * @type {object}
 * @property {string} permission - Required permission level ('moderator')
 * @property {Function} execute - Command execution function
 */
module.exports = {
    /**
     * Permission level required to execute this subcommand
     * 
     * Requires moderator role to prevent unauthorized player removal.
     * This ensures only trusted users can kick players from guilds.
     * 
     * @type {string}
     */
    permission: 'moderator',
    
    /**
     * Execute the kick subcommand
     * 
     * Entry point for the kick command. Defers the reply immediately
     * to prevent timeout, then delegates to handleKickCommand for processing.
     * 
     * @async
     * @param {ChatInputCommandInteraction} interaction - Discord interaction object
     * @param {object} context - Command execution context
     * @param {Client} context.client - Discord client instance
     * @param {object} context.config - Configuration object
     * @param {object} context.bridgeLocator - BridgeLocator instance
     * @returns {Promise<void>}
     */
    async execute(interaction, context) {
        // Defer the reply since this might take some time
        await interaction.deferReply({ ephemeral: true });
        
        await handleKickCommand(interaction, context);
    },
};

/**
 * Handle kick command execution
 * 
 * Main logic for kicking a player from a guild. Performs validation,
 * sends the kick command with reason to Minecraft, tracks the response, and
 * updates the Discord user with the result through embeds.
 * 
 * Execution Flow:
 * 1. Extract command parameters (guild name, username, reason)
 * 2. Validate Minecraft manager availability
 * 3. Find and validate guild configuration
 * 4. Verify guild connection status
 * 5. Validate username format
 * 6. Format command with reason
 * 7. Create response listener for tracking
 * 8. Send initial processing embed with reason
 * 9. Execute kick command in Minecraft
 * 10. Wait for response from listener (15s timeout)
 * 11. Update embed with final result
 * 12. Log the outcome for audit
 * 
 * Reason Handling:
 * - Default to "No reason provided" if reason is empty
 * - Include reason in Minecraft command: /g kick <username> <reason>
 * - Display reason in all embeds for transparency
 * - Log reason in audit trail
 * 
 * Error Handling:
 * - Manager unavailable: Error message to user
 * - Guild not found: List available guilds
 * - Guild not connected: Connection status message
 * - Invalid username: Format validation message with requirements
 * - Command execution failure: Error details with cancellation
 * - Unexpected errors: Generic error message with details
 * 
 * @async
 * @private
 * @param {ChatInputCommandInteraction} interaction - Discord interaction object
 * @param {object} context - Command execution context
 * @returns {Promise<void>}
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

        // Prepare Minecraft command with reason
        const command = `/g kick ${username} ${reason}`;

        // Record the reason so the detection notification (fired a few ms later when
        // Hypixel rebroadcasts the kick) can forward it to FrenchLegacy-Discord, which
        // DMs the kicked player. Stored before sending because the parsed kick event
        // can arrive before this command's response resolves.
        kickReasonStore.set(guildConfig.id, username, reason);

        // Set up command response listener
        const responseListener = getCommandResponseListener();
        const listenerId = responseListener.createListener(
            guildConfig.id,
            'kick',
            username,
            command,
            15000, // 15 second timeout
            interaction
        );

        // Send initial response with reason displayed
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
            // Execute command in Minecraft
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
            
            // Send command execution error embed
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
        // Handle unexpected errors
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
 * 
 * Searches for a guild in the configuration by name (case-insensitive)
 * and verifies it is enabled. Only returns enabled guilds.
 * 
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
 * 
 * Returns an array of enabled guild names from configuration.
 * Used for displaying available options when a guild is not found.
 * 
 * @param {object} config - Configuration object
 * @returns {Array<string>} Array of enabled guild names
 */
function getAvailableGuilds(config) {
    const guilds = config.get('guilds') || [];
    return guilds
        .filter(guild => guild.enabled)
        .map(guild => guild.name);
}

/**
 * Validate Minecraft username format
 * 
 * Checks if username follows Minecraft's username requirements:
 * - 3 to 16 characters long
 * - Alphanumeric characters (a-z, A-Z, 0-9)
 * - Underscores allowed
 * - No other special characters
 * 
 * @param {string} username - Username to validate
 * @returns {boolean} True if username is valid
 */
function isValidMinecraftUsername(username) {
    // Minecraft usernames: 3-16 characters, letters, numbers, underscores
    const minecraftUsernameRegex = /^[a-zA-Z0-9_]{3,16}$/;
    return minecraftUsernameRegex.test(username);
}

/**
 * Create response embed based on command result
 * 
 * Generates a color-coded embed displaying the kick command result.
 * Different colors, titles, and messages are used based on success, failure type,
 * timeout, system error, or cancellation. Always includes the kick reason for
 * transparency and audit purposes.
 * 
 * Embed Colors:
 * - Success: Green (0x00FF00)
 * - Command Error: Red (0xFF0000)
 * - Timeout: Orange (0xFFA500)
 * - System Error: Red (0xFF0000)
 * - Cancelled: Gray (0x808080)
 * - Unknown Error: Red (0xFF0000)
 * 
 * Result Types:
 * - success: Player kicked successfully
 * - timeout: No response from Minecraft within 15s
 * - command_error: Minecraft rejected the kick (player not in guild, insufficient perms, etc.)
 * - system_error: System-level failure in command processing
 * - cancelled: Command was cancelled before completion
 * 
 * @param {string} guildName - Guild name
 * @param {string} username - Player username
 * @param {string} reason - Kick reason provided by executor
 * @param {object} result - Command result from listener
 * @param {boolean} result.success - Whether command succeeded
 * @param {string} result.message - Success message (if success)
 * @param {string} result.error - Error message (if failure)
 * @param {string} result.type - Result type (success, timeout, command_error, system_error, cancelled)
 * @returns {EmbedBuilder} Configured embed builder
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
        // Success case
        embed
            .setTitle('✅ Guild Kick Successful')
            .setDescription(`Successfully kicked \`${username}\` from guild \`${guildName}\`!`)
            .setColor(0x00FF00) // Green color for success
            .addFields(
                { name: '📝 Response', value: result.message || 'Player kicked successfully', inline: false }
            );
    } else {
        // Failure cases - determine title, description, and color based on error type
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