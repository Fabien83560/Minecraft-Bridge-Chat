// Globals Imports
const { EmbedBuilder } = require("discord.js");

// Specific Imports
const CommandResponseListener = require("../../handlers/CommandResponseListener.js");
const BridgeLocator = require('../../../../bridgeLocator.js');
const logger = require("../../../../shared/logger");

let commandResponseListener = null;
function getCommandResponseListener() {
  if (!commandResponseListener) {
    commandResponseListener = new CommandResponseListener();
  }
  return commandResponseListener;
}

module.exports = {
  permission: "moderator",

  async execute(interaction, context) {
    await interaction.deferReply();
    await handleSetRankCommand(interaction, context);
  },
};

async function handleSetRankCommand(interaction, context) {
  const guildName = interaction.options.getString("guildname");
  const username = interaction.options.getString("username");
  const rank = interaction.options.getString("rank");

  try {
    logger.discord(
      `[GUILD-SETRANK] Processing setrank command: ${guildName} -> ${username} = ${rank}`
    );

    const minecraftManager = context.bridgeLocator.getMinecraftManager?.();
    if (!minecraftManager) {
      await interaction.editReply({
        content: "❌ Minecraft manager not available. Please try again later.",
        ephemeral: true,
      });
      return;
    }

    const guildConfig = findGuildByName(context.config, guildName);
    if (!guildConfig) {
      await interaction.editReply({
        content: `❌ Guild \`${guildName}\` not found. Available guilds: ${getAvailableGuilds(
          context.config
        ).join(", ")}`,
        ephemeral: true,
      });
      return;
    }

    const botManager = minecraftManager._botManager;
    if (!botManager || !botManager.isGuildConnected(guildConfig.id)) {
      await interaction.editReply({
        content: `❌ Guild \`${guildName}\` is not currently connected to Minecraft.`,
        ephemeral: true,
      });
      return;
    }

    if (!isValidMinecraftUsername(username)) {
      await interaction.editReply({
        content: `❌ Invalid username format: \`${username}\`.`,
        ephemeral: true,
      });
      return;
    }

    const validRanks = getValidRanksForGuild(guildName);
    if (!validRanks.map((r) => r.toLowerCase()).includes(rank.toLowerCase())) {
      await interaction.editReply({
        content: `❌ Invalid rank: \`${rank}\`. Valid ranks for ${guildName}: ${validRanks.join(
          ", "
        )}`,
        ephemeral: true,
      });
      return;
    }

    const command = `/g setrank ${username} ${rank}`;

    const responseListener = getCommandResponseListener();
    const listenerId = responseListener.createListener(
      guildConfig.id,
      "setrank",
      username,
      command,
      15000,
      interaction
    );

    const initialEmbed = new EmbedBuilder()
      .setTitle("🔄 Processing Guild Rank Change")
      .setDescription(
        `Setting rank for \`${username}\` in guild \`${guildName}\` to \`${rank}\`...`
      )
      .setColor(0xffa500)
      .addFields(
        { name: "👤 Player", value: username, inline: true },
        { name: "🏰 Guild", value: guildName, inline: true },
        { name: "🎖️ Rank", value: rank, inline: true },
        {
          name: "⏱️ Status",
          value: "Sending setrank command...",
          inline: false,
        }
      )
      .setTimestamp();

    await interaction.editReply({ embeds: [initialEmbed] });

    try {
      await botManager.executeCommand(guildConfig.id, command);
      logger.discord(
        `[GUILD-SETRANK] Command sent to ${guildName}: ${command}`
      );

      const result = await responseListener.waitForResult(listenerId);
      const responseEmbed = createResponseEmbed(
        guildName,
        username,
        rank,
        result
      );
      await interaction.editReply({ embeds: [responseEmbed] });
    } catch (commandError) {
      logger.logError(
        commandError,
        `[GUILD-SETRANK] Failed to execute setrank command`
      );
      responseListener.cancelListener(listenerId);

      const errorEmbed = new EmbedBuilder()
        .setTitle("❌ Command Execution Failed")
        .setDescription(`Failed to execute setrank command for \`${username}\``)
        .setColor(0xff0000)
        .addFields(
          { name: "👤 Player", value: username, inline: true },
          { name: "🏰 Guild", value: guildName, inline: true },
          { name: "🎖️ Rank", value: rank, inline: true },
          {
            name: "🚫 Error",
            value: commandError.message || "Unknown error occurred",
            inline: false,
          }
        )
        .setTimestamp();

      await interaction.editReply({ embeds: [errorEmbed] });
    }
  } catch (error) {
    logger.logError(
      error,
      `[GUILD-SETRANK] Unexpected error processing setrank command`
    );
    const errorEmbed = new EmbedBuilder()
      .setTitle("❌ Unexpected Error")
      .setDescription(
        "An unexpected error occurred while processing the setrank command."
      )
      .setColor(0xff0000)
      .addFields({
        name: "🚫 Error",
        value: error.message || "Unknown error",
        inline: false,
      })
      .setTimestamp();
    await interaction.editReply({ embeds: [errorEmbed] });
  }
}

function findGuildByName(config, guildName) {
  const guilds = config.get("guilds") || [];
  return guilds.find(
    (guild) =>
      guild.name.toLowerCase() === guildName.toLowerCase() && guild.enabled
  );
}

function getAvailableGuilds(config) {
  const guilds = config.get("guilds") || [];
  return guilds.filter((guild) => guild.enabled).map((guild) => guild.name);
}

function isValidMinecraftUsername(username) {
  const minecraftUsernameRegex = /^[a-zA-Z0-9_]{3,16}$/;
  return minecraftUsernameRegex.test(username);
}

/**
 * Get valid ranks for a guild dynamically from configuration
 * @param {string} guildName - Name of the guild
 * @returns {Array<string>} - Array of valid ranks
 */
function getValidRanksForGuild(guildName) {
    try {
        const guilds = BridgeLocator.getInstance().config.get("guilds") || [];
        
        const guild = guilds.find(g => 
            g.name.toLowerCase() === guildName.toLowerCase() && g.enabled
        );
        
        if (!guild) {
            logger.warn(`Guild '${guildName}' not found in configuration`);
            return [];
        }
        
        return guild.ranks || [];
        
    } catch (error) {
        logger.logError(error, `Error getting ranks for guild '${guildName}'`);
        return [];
    }
}

function createResponseEmbed(guildName, username, rank, result) {
  const embed = new EmbedBuilder()
    .addFields(
      { name: "👤 Player", value: username, inline: true },
      { name: "🏰 Guild", value: guildName, inline: true },
      { name: "🎖️ Rank", value: rank, inline: true }
    )
    .setTimestamp();

  if (result.success) {
    embed
      .setTitle("✅ Rank Set Successful")
      .setDescription(
        `Successfully set \`${username}\`'s rank to \`${rank}\` in \`${guildName}\`.`
      )
      .setColor(0x00ff00)
      .addFields({
        name: "📝 Response",
        value: result.message || "Rank updated",
        inline: false,
      });
  } else {
    let title = "❌ Rank Set Failed";
    let description = `Failed to set rank for \`${username}\`.`;
    let color = 0xff0000;
    if (result.type === "timeout") {
      title = "⏰ Command Timeout";
      description = "No response received from Minecraft within 15 seconds.";
      color = 0xffa500;
    } else if (result.type === "cancelled") {
      title = "🚫 Command Cancelled";
      description = "The setrank command was cancelled.";
      color = 0x808080;
    }

    embed
      .setTitle(title)
      .setDescription(description)
      .setColor(color)
      .addFields({
        name: "🚫 Error",
        value: result.error || "Unknown error",
        inline: false,
      });
  }

  return embed;
}
