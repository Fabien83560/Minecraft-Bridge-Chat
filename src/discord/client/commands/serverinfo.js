// Globals Imports
const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('serverinfo')
        .setDescription('Displays information about the current server'),
    
    // Permission level (optional)
    permission: 'user', // 'user', 'mod', 'admin'
    
    async execute(interaction) {
        // Defer the reply to prevent timeout on large servers
        await interaction.deferReply();
        
        const guild = interaction.guild;
        
        if (!guild) {
            await interaction.editReply({
                content: 'This command can only be used in a server!',
                ephemeral: true
            });
            return;
        }

        try {
            // Get server statistics
            const memberCount = guild.memberCount;
            const channelCount = guild.channels.cache.size;
            const roleCount = guild.roles.cache.size;
            const emojiCount = guild.emojis.cache.size;
            
            // Get boost information
            const boostLevel = guild.premiumTier;
            const boostCount = guild.premiumSubscriptionCount || 0;
            
            // Get creation date
            const createdAt = guild.createdAt;
            const createdTimestamp = Math.floor(createdAt.getTime() / 1000);
            
            // Get verification level
            const verificationLevels = {
                0: 'None',
                1: 'Low',
                2: 'Medium',
                3: 'High',
                4: 'Very High'
            };
            
            const verificationLevel = verificationLevels[guild.verificationLevel] || 'Unknown';
            
            // Create embed
            const embed = new EmbedBuilder()
                .setTitle(`📊 ${guild.name} Server Information`)
                .setThumbnail(guild.iconURL({ dynamic: true, size: 1024 }))
                .setColor(0x0099FF)
                .addFields(
                    {
                        name: '👥 Members',
                        value: `${memberCount.toLocaleString()}`,
                        inline: true
                    },
                    {
                        name: '📁 Channels',
                        value: `${channelCount.toLocaleString()}`,
                        inline: true
                    },
                    {
                        name: '🎭 Roles',
                        value: `${roleCount.toLocaleString()}`,
                        inline: true
                    },
                    {
                        name: '😀 Emojis',
                        value: `${emojiCount.toLocaleString()}`,
                        inline: true
                    },
                    {
                        name: '🚀 Boost Level',
                        value: `Level ${boostLevel} (${boostCount} boosts)`,
                        inline: true
                    },
                    {
                        name: '🔒 Verification Level',
                        value: verificationLevel,
                        inline: true
                    },
                    {
                        name: '📅 Created',
                        value: `<t:${createdTimestamp}:F>\n(<t:${createdTimestamp}:R>)`,
                        inline: false
                    }
                )
                .setFooter({
                    text: `Server ID: ${guild.id}`,
                    iconURL: interaction.client.user.displayAvatarURL()
                })
                .setTimestamp();

            // Add owner information if available
            if (guild.ownerId) {
                try {
                    const owner = await guild.members.fetch(guild.ownerId);
                    embed.addFields({
                        name: '👑 Owner',
                        value: `${owner.user.tag} (${owner.user.id})`,
                        inline: false
                    });
                } catch (error) {
                    // Owner might not be cached, skip this field
                }
            }

            await interaction.editReply({ embeds: [embed] });
            
        } catch (error) {
            console.error('Error in serverinfo command:', error);
            await interaction.editReply({
                content: 'An error occurred while fetching server information.',
                ephemeral: true
            });
        }
    },
};