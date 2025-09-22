// Globals Imports
const { EmbedBuilder } = require("discord.js");

// Specific Imports
const CommandResponseListener = require("../../handlers/CommandResponseListener.js");
const logger = require("../../../../shared/logger");

// Singleton instance for command response listener
let commandResponseListener = null;

function getCommandResponseListener() {
  if (!commandResponseListener) {
    commandResponseListener = new CommandResponseListener();
  }
  return commandResponseListener;
}

module.exports = {
  permission: "mod",

  async execute(interaction, context) {
    await interaction.deferReply();
    await handlePromoteCommand(interaction, context);
  },
};

async function handlePromoteCommand(interaction, context) {
  const guildName = interaction.options.getString("guildname");
  const username = interaction.options.getString("username");

  try {
    logger.discord(
      `[GUILD-PROMOTE] Processing promote command: ${guildName} -> ${username}`
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

    const responseListener = getCommandResponseListener();
    const listenerId = responseListener.createListener(
      guildConfig.id,
      "promote",
      username,
      15000,
      interaction
    );

    const initialEmbed = new EmbedBuilder()
      .setTitle("🔄 Processing Guild Promotion")
      .setDescription(`Promoting \`${username}\` in guild \`${guildName}\`...`)
      .setColor(0xffa500)
      .addFields(
        { name: "👤 Player", value: username, inline: true },
        { name: "🏰 Guild", value: guildName, inline: true },
        {
          name: "⏱️ Status",
          value: "Sending promote command...",
          inline: false,
        }
      )
      .setTimestamp();

    await interaction.editReply({ embeds: [initialEmbed] });

    try {
      const command = `/g promote ${username}`;
      await botManager.executeCommand(guildConfig.id, command);
      logger.discord(
        `[GUILD-PROMOTE] Command sent to ${guildName}: ${command}`
      );

      const result = await responseListener.waitForResult(listenerId);
      const responseEmbed = createResponseEmbed(guildName, username, result);
      await interaction.editReply({ embeds: [responseEmbed] });
    } catch (commandError) {
      logger.logError(
        commandError,
        `[GUILD-PROMOTE] Failed to execute promote command`
      );
      responseListener.cancelListener(listenerId);

      const errorEmbed = new EmbedBuilder()
        .setTitle("❌ Command Execution Failed")
        .setDescription(`Failed to execute promote command for \`${username}\``)
        .setColor(0xff0000)
        .addFields(
          { name: "👤 Player", value: username, inline: true },
          { name: "🏰 Guild", value: guildName, inline: true },
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
      `[GUILD-PROMOTE] Unexpected error processing promote command`
    );
    const errorEmbed = new EmbedBuilder()
      .setTitle("❌ Unexpected Error")
      .setDescription(
        "An unexpected error occurred while processing the promote command."
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

function createResponseEmbed(guildName, username, result) {
  const embed = new EmbedBuilder()
    .addFields(
      { name: "👤 Player", value: username, inline: true },
      { name: "🏰 Guild", value: guildName, inline: true }
    )
    .setTimestamp();

  if (result.success) {
    embed
      .setTitle("✅ Guild Promotion Successful")
      .setDescription(
        `Successfully promoted \`${username}\` in guild \`${guildName}\`.`
      )
      .setColor(0x00ff00)
      .addFields({
        name: "📝 Response",
        value: result.message || "Promotion successful",
        inline: false,
      });
  } else {
    let title = "❌ Promotion Failed";
    let description = `Failed to promote \`${username}\` in guild \`${guildName}\`.`;
    let color = 0xff0000;
    if (result.type === "timeout") {
      title = "⏰ Command Timeout";
      description = "No response received from Minecraft within 15 seconds.";
      color = 0xffa500;
    } else if (result.type === "cancelled") {
      title = "🚫 Command Cancelled";
      description = "The promote command was cancelled.";
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
