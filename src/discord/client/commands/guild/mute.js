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
    await interaction.deferReply();
    await handleMuteCommand(interaction, context);
  },
};

async function handleMuteCommand(interaction, context) {
  const guildName = interaction.options.getString("guildname");
  const scope = interaction.options.getString("scope");
  const username = interaction.options.getString("username");
  const time = interaction.options.getString("time");

  try {
    logger.discord(
      `[GUILD-MUTE] Processing mute command: ${guildName} -> ${scope} ${username ? `(${username})` : ''} for ${time}`
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
          content: "❌ Username is required when muting a specific player.",
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

    // Validate time format
    if (!isValidTimeFormat(time)) {
      await interaction.editReply({
        content: "❌ Invalid time format. Use formats like: 1h, 30m, 2d, etc.",
        ephemeral: true,
      });
      return;
    }

    // Construct the appropriate command
    let command;
    if (scope === "global") {
      command = `/g mute everyone ${time}`;
    } else {
      command = `/g mute ${username} ${time}`;
    }

    // Create command response listener
    const responseListener = getCommandResponseListener();
    const listenerId = responseListener.createListener(
      guildConfig.id,
      "mute",
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

      logger.discord(`[GUILD-MUTE] Executing command: ${command}`);

      // Execute the command
      await connection.executeCommand(command);

      // Wait for response
      const result = await responseListener.waitForResult(listenerId);

      // Create response embed
      const embed = createMuteResponseEmbed(guildName, scope, username, time, result);
      await interaction.editReply({ embeds: [embed] });

    } catch (commandError) {
      logger.logError(commandError, `[GUILD-MUTE] Command execution failed`);

      // Cancel listener since command execution failed
      responseListener.cancelListener(listenerId);

      const errorEmbed = new EmbedBuilder()
        .setTitle("❌ Command Execution Failed")
        .setDescription(`Failed to execute mute command for \`${scope === "global" ? "guild" : username}\``)
        .setColor(0xff0000)
        .addFields(
          { name: "🏰 Guild", value: guildName, inline: true },
          { name: "🔇 Scope", value: scope, inline: true },
          { name: "⏰ Duration", value: time, inline: true },
          { name: "🚫 Error", value: commandError.message || "Unknown error occurred", inline: false }
        )
        .setTimestamp();

      if (scope === "player") {
        errorEmbed.addFields({ name: "👤 Player", value: username, inline: true });
      }

      await interaction.editReply({ embeds: [errorEmbed] });
    }
  } catch (error) {
    logger.logError(error, `[GUILD-MUTE] Unexpected error processing mute command`);

    const errorEmbed = new EmbedBuilder()
      .setTitle("❌ Unexpected Error")
      .setDescription("An unexpected error occurred while processing the mute command.")
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

function isValidTimeFormat(timeString) {
  // Accept formats like: 1h, 30m, 2d, 1h30m, 45s, etc.
  const timeRegex = /^(\d+[smhd])+$/i;
  return timeRegex.test(timeString);
}

function createMuteResponseEmbed(guildName, scope, username, time, result) {
  const embed = new EmbedBuilder()
    .addFields(
      { name: "🏰 Guild", value: guildName, inline: true },
      { name: "🔇 Scope", value: scope, inline: true },
      { name: "⏰ Duration", value: time, inline: true }
    )
    .setTimestamp();

  if (scope === "player") {
    embed.addFields({ name: "👤 Player", value: username, inline: true });
  }

  if (result.success) {
    embed
      .setTitle("✅ Guild Mute Successful")
      .setDescription(
        scope === "global"
          ? `Successfully muted guild \`${guildName}\` for ${time}.`
          : `Successfully muted \`${username}\` in guild \`${guildName}\` for ${time}.`
      )
      .setColor(0x00ff00)
      .addFields({
        name: "📝 Response",
        value: result.message || "Mute applied successfully",
        inline: false,
      });
  } else {
    let title = "❌ Mute Failed";
    let description = scope === "global"
      ? `Failed to mute guild \`${guildName}\`.`
      : `Failed to mute \`${username}\` in guild \`${guildName}\`.`;
    let color = 0xff0000;

    if (result.type === "timeout") {
      title = "⏰ Command Timeout";
      description = "No response received from Minecraft within 15 seconds.";
      color = 0xffa500;
    } else if (result.type === "cancelled") {
      title = "🚫 Command Cancelled";
      description = "The mute command was cancelled.";
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