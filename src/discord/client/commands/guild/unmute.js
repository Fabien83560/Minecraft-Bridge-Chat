// Globals Imports
const { EmbedBuilder } = require("discord.js");

// Specific Imports
const CommandResponseListener = require("../../handlers/CommandResponseListener.js");
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
    await interaction.deferReply({ ephemeral: true });
    await handleUnmuteCommand(interaction, context);
  },
};

async function handleUnmuteCommand(interaction, context) {
  const guildName = interaction.options.getString("guildname");
  const scope = interaction.options.getString("scope");
  const username = interaction.options.getString("username");

  try {
    logger.discord(
      `[GUILD-UNMUTE] Processing unmute command: ${guildName} -> ${scope} ${username ? `(${username})` : ''}`
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

    // Validate inputs based on scope
    if (scope === "player") {
      if (!username) {
        await interaction.editReply({
          content: "❌ Username is required when unmuting a specific player.",
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
    }

    // Construct the appropriate command
    let command;
    if (scope === "global") {
      command = `/g unmute everyone`;
    } else {
      command = `/g unmute ${username}`;
    }

    // Create command response listener
    const responseListener = getCommandResponseListener();
    const listenerId = responseListener.createListener(
      guildConfig.id,
      "unmute",
      username || "everyone",
      command,
      15000, // 15 second timeout
      interaction
    );

    try {
      // Get the connection for this guild
      const connection = botManager.connections.get(guildConfig.id);
      if (!connection) {
        responseListener.cancelListener(listenerId);
        await interaction.editReply({
          content: `❌ No active connection found for guild \`${guildName}\`.`,
          ephemeral: true,
        });
        return;
      }

      logger.discord(`[GUILD-UNMUTE] Executing command: ${command}`);

      // Execute the command
      await connection.executeCommand(command);

      // Wait for response
      const result = await responseListener.waitForResult(listenerId);

      // Create response embed
      const embed = createUnmuteResponseEmbed(guildName, scope, username, result);
      await interaction.editReply({ embeds: [embed] });

    } catch (commandError) {
      logger.logError(commandError, `[GUILD-UNMUTE] Command execution failed`);

      // Cancel listener since command execution failed
      responseListener.cancelListener(listenerId);

      const errorEmbed = new EmbedBuilder()
        .setTitle("❌ Command Execution Failed")
        .setDescription(`Failed to execute unmute command for \`${scope === "global" ? "guild" : username}\``)
        .setColor(0xff0000)
        .addFields(
          { name: "🏰 Guild", value: guildName, inline: true },
          { name: "🔊 Scope", value: scope, inline: true },
          { name: "🚫 Error", value: commandError.message || "Unknown error occurred", inline: false }
        )
        .setTimestamp();

      if (scope === "player") {
        errorEmbed.addFields({ name: "👤 Player", value: username, inline: true });
      }

      await interaction.editReply({ embeds: [errorEmbed] });
    }
  } catch (error) {
    logger.logError(error, `[GUILD-UNMUTE] Unexpected error processing unmute command`);

    const errorEmbed = new EmbedBuilder()
      .setTitle("❌ Unexpected Error")
      .setDescription("An unexpected error occurred while processing the unmute command.")
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

function createUnmuteResponseEmbed(guildName, scope, username, result) {
  const embed = new EmbedBuilder()
    .addFields(
      { name: "🏰 Guild", value: guildName, inline: true },
      { name: "🔊 Scope", value: scope, inline: true }
    )
    .setTimestamp();

  if (scope === "player") {
    embed.addFields({ name: "👤 Player", value: username, inline: true });
  }

  if (result.success) {
    embed
      .setTitle("✅ Guild Unmute Successful")
      .setDescription(
        scope === "global"
          ? `Successfully unmuted guild \`${guildName}\`.`
          : `Successfully unmuted \`${username}\` in guild \`${guildName}\`.`
      )
      .setColor(0x00ff00)
      .addFields({
        name: "📝 Response",
        value: result.message || "Unmute applied successfully",
        inline: false,
      });
  } else {
    let title = "❌ Unmute Failed";
    let description = scope === "global"
      ? `Failed to unmute guild \`${guildName}\`.`
      : `Failed to unmute \`${username}\` in guild \`${guildName}\`.`;
    let color = 0xff0000;

    if (result.type === "timeout") {
      title = "⏰ Command Timeout";
      description = "No response received from Minecraft within 15 seconds.";
      color = 0xffa500;
    } else if (result.type === "cancelled") {
      title = "🚫 Command Cancelled";
      description = "The unmute command was cancelled.";
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