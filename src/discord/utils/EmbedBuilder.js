// Globals Imports
const { EmbedBuilder: DiscordEmbedBuilder } = require('discord.js');

// Specific Imports
const BridgeLocator = require("../../bridgeLocator.js");
const { getTemplateLoader } = require("../../config/TemplateLoader.js");
const logger = require("../../shared/logger");

class EmbedBuilder {
    constructor() {
        const mainBridge = BridgeLocator.getInstance();
        this.config = mainBridge.config;
        this.templateLoader = getTemplateLoader();

        // Default colors from templates
        this.colors = this.templateLoader.getDefaults('colors') || {
            guild: 3447003,      // Blue
            officer: 15844367,   // Orange
            event: 3066993,      // Green
            system: 9807270,     // Gray
            error: 15158332,     // Red
            success: 3066993,    // Green
            warning: 15844367    // Orange
        };

        // Default emojis from templates
        this.emojis = this.templateLoader.getDefaults('emojis') || {
            guild: '💬',
            officer: '🛡️',
            join: '👋',
            leave: '👋',
            kick: '🚫',
            promote: '⬆️',
            demote: '⬇️',
            level: '🎉',
            motd: '📝',
            system: '⚙️',
            error: '❌',
            success: '✅',
            warning: '⚠️'
        };

        logger.debug('EmbedBuilder initialized');
    }

    /**
     * Create guild message embed
     * @param {object} messageData - Message data
     * @param {object} guildConfig - Guild configuration
     * @returns {EmbedBuilder} Discord embed
     */
    createGuildMessageEmbed(messageData, guildConfig) {
        const embed = new DiscordEmbedBuilder();
        
        const chatType = messageData.chatType || 'guild';
        const emoji = chatType === 'officer' ? this.emojis.officer : this.emojis.guild;
        const color = chatType === 'officer' ? this.colors.officer : this.colors.guild;

        embed
            .setColor(color)
            .setTitle(`${emoji} ${chatType.charAt(0).toUpperCase() + chatType.slice(1)} Chat - ${guildConfig.name}`)
            .setDescription(`**${messageData.username}**: ${messageData.message}`)
            .setFooter({
                text: `From ${guildConfig.name} [${guildConfig.tag}]`,
                iconURL: this.getGuildIcon(guildConfig)
            })
            .setTimestamp();

        // Add rank if available
        if (messageData.rank) {
            embed.addFields({
                name: 'Rank',
                value: messageData.rank,
                inline: true
            });
        }

        return embed;
    }

    /**
     * Create guild event embed
     * @param {object} eventData - Event data
     * @param {object} guildConfig - Guild configuration
     * @returns {EmbedBuilder} Discord embed
     */
    createGuildEventEmbed(eventData, guildConfig) {
        const embed = new DiscordEmbedBuilder();
        
        const eventType = eventData.type;
        const emoji = this.emojis[eventType] || this.emojis.system;
        const color = this.colors.event;

        embed
            .setColor(color)
            .setTitle(`${emoji} Guild Event - ${this.formatEventType(eventType)}`)
            .setFooter({
                text: `${guildConfig.name} [${guildConfig.tag}]`,
                iconURL: this.getGuildIcon(guildConfig)
            })
            .setTimestamp();

        // Add event-specific fields
        this.addEventFields(embed, eventData);

        return embed;
    }

    /**
     * Add event-specific fields to embed
     * @param {EmbedBuilder} embed - Discord embed builder
     * @param {object} eventData - Event data
     */
    addEventFields(embed, eventData) {
        const eventType = eventData.type;

        switch (eventType) {
            case 'join':
            case 'welcome':
                embed.setDescription(`**${eventData.username}** joined the guild! 👋`);
                if (eventData.rank) {
                    embed.addFields({
                        name: 'Rank',
                        value: eventData.rank,
                        inline: true
                    });
                }
                break;

            case 'leave':
                embed.setDescription(`**${eventData.username}** left the guild 👋`);
                if (eventData.reason) {
                    embed.addFields({
                        name: 'Reason',
                        value: eventData.reason,
                        inline: true
                    });
                }
                break;

            case 'kick':
                embed.setDescription(`**${eventData.username}** was kicked from the guild 🚫`);
                if (eventData.reason) {
                    embed.addFields({
                        name: 'Reason',
                        value: eventData.reason,
                        inline: true
                    });
                }
                break;

            case 'promote':
                embed.setDescription(`**${eventData.username}** was promoted! ⬆️`);
                if (eventData.fromRank && eventData.toRank) {
                    embed.addFields({
                        name: 'Promotion',
                        value: `${eventData.fromRank} → ${eventData.toRank}`,
                        inline: true
                    });
                } else if (eventData.toRank) {
                    embed.addFields({
                        name: 'New Rank',
                        value: eventData.toRank,
                        inline: true
                    });
                }
                if (eventData.promoter) {
                    embed.addFields({
                        name: 'Promoted by',
                        value: eventData.promoter,
                        inline: true
                    });
                }
                break;

            case 'demote':
                embed.setDescription(`**${eventData.username}** was demoted ⬇️`);
                if (eventData.fromRank && eventData.toRank) {
                    embed.addFields({
                        name: 'Demotion',
                        value: `${eventData.fromRank} → ${eventData.toRank}`,
                        inline: true
                    });
                } else if (eventData.toRank) {
                    embed.addFields({
                        name: 'New Rank',
                        value: eventData.toRank,
                        inline: true
                    });
                }
                if (eventData.demoter) {
                    embed.addFields({
                        name: 'Demoted by',
                        value: eventData.demoter,
                        inline: true
                    });
                }
                break;

            case 'level':
                embed.setDescription(`Guild reached level **${eventData.level}**! 🎉`);
                if (eventData.previousLevel) {
                    embed.addFields({
                        name: 'Level Up',
                        value: `${eventData.previousLevel} → ${eventData.level}`,
                        inline: true
                    });
                }
                break;

            case 'motd':
                embed.setDescription(`**${eventData.changer}** changed the guild MOTD 📝`);
                if (eventData.motd) {
                    embed.addFields({
                        name: 'New MOTD',
                        value: eventData.motd.length > 1024 ? eventData.motd.substring(0, 1021) + '...' : eventData.motd,
                        inline: false
                    });
                }
                break;

            case 'invite':
                if (eventData.inviteAccepted) {
                    embed.setDescription(`**${eventData.invited}** accepted **${eventData.inviter}**'s guild invitation`);
                } else {
                    embed.setDescription(`**${eventData.inviter}** invited **${eventData.invited}** to the guild`);
                }
                break;

            case 'online':
                embed.setDescription(`Guild members online: **${eventData.onlineCount}**`);
                if (eventData.members && eventData.members.length <= 10) {
                    embed.addFields({
                        name: 'Online Members',
                        value: eventData.members.join(', '),
                        inline: false
                    });
                } else if (eventData.members && eventData.members.length > 10) {
                    embed.addFields({
                        name: 'Online Members',
                        value: eventData.members.slice(0, 10).join(', ') + ` and ${eventData.members.length - 10} more...`,
                        inline: false
                    });
                }
                break;

            default:
                embed.setDescription(`Guild event: **${eventType}**`);
                if (eventData.username) {
                    embed.addFields({
                        name: 'User',
                        value: eventData.username,
                        inline: true
                    });
                }
                break;
        }
    }

    /**
     * Create connection status embed
     * @param {object} guildConfig - Guild configuration
     * @param {string} status - Connection status
     * @param {object} details - Additional details
     * @returns {EmbedBuilder} Discord embed
     */
    createConnectionEmbed(guildConfig, status, details = {}) {
        const embed = new DiscordEmbedBuilder();

        let color, emoji, title, description;

        switch (status) {
            case 'connected':
                color = this.colors.success;
                emoji = this.emojis.success;
                title = `${emoji} Guild Connected`;
                description = `**${guildConfig.name}** bot successfully connected to Hypixel`;
                break;

            case 'disconnected':
                color = this.colors.error;
                emoji = this.emojis.error;
                title = `${emoji} Guild Disconnected`;
                description = `**${guildConfig.name}** bot disconnected from Hypixel`;
                break;

            case 'reconnected':
                color = this.colors.warning;
                emoji = this.emojis.warning;
                title = `🔄 Guild Reconnected`;
                description = `**${guildConfig.name}** bot reconnected to Hypixel`;
                break;

            default:
                color = this.colors.system;
                emoji = this.emojis.system;
                title = `${emoji} Guild Status`;
                description = `**${guildConfig.name}** status: ${status}`;
                break;
        }

        embed
            .setColor(color)
            .setTitle(title)
            .setDescription(description)
            .setFooter({
                text: `${guildConfig.name} [${guildConfig.tag}]`,
                iconURL: this.getGuildIcon(guildConfig)
            })
            .setTimestamp();

        // Add connection details
        if (details.connectionTime) {
            embed.addFields({
                name: 'Connection Time',
                value: details.connectionTime,
                inline: true
            });
        }

        if (details.attempt) {
            embed.addFields({
                name: 'Attempt',
                value: details.attempt.toString(),
                inline: true
            });
        }

        if (details.reason) {
            embed.addFields({
                name: 'Reason',
                value: details.reason,
                inline: true
            });
        }

        // Add server info
        embed.addFields({
            name: 'Server',
            value: guildConfig.server.serverName,
            inline: true
        });

        embed.addFields({
            name: 'Bot Account',
            value: guildConfig.account.username,
            inline: true
        });

        return embed;
    }

    /**
     * Create system message embed
     * @param {string} type - System message type
     * @param {object} data - System message data
     * @param {object} guildConfig - Guild configuration
     * @returns {EmbedBuilder} Discord embed
     */
    createSystemEmbed(type, data, guildConfig) {
        const embed = new DiscordEmbedBuilder();

        const color = type.includes('error') ? this.colors.error : 
                     type.includes('warning') ? this.colors.warning :
                     type.includes('success') ? this.colors.success :
                     this.colors.system;

        const emoji = type.includes('error') ? this.emojis.error :
                     type.includes('warning') ? this.emojis.warning :
                     type.includes('success') ? this.emojis.success :
                     this.emojis.system;

        embed
            .setColor(color)
            .setTitle(`${emoji} System Message`)
            .setDescription(data.message || `System event: ${type}`)
            .setFooter({
                text: `${guildConfig.name} [${guildConfig.tag}]`,
                iconURL: this.getGuildIcon(guildConfig)
            })
            .setTimestamp();

        // Add system data fields
        if (data.context) {
            embed.addFields({
                name: 'Context',
                value: data.context,
                inline: true
            });
        }

        if (data.details) {
            embed.addFields({
                name: 'Details',
                value: typeof data.details === 'object' ? JSON.stringify(data.details, null, 2) : data.details,
                inline: false
            });
        }

        return embed;
    }

    /**
     * Format event type for display
     * @param {string} eventType - Event type
     * @returns {string} Formatted event type
     */
    formatEventType(eventType) {
        return eventType
            .split('_')
            .map(word => word.charAt(0).toUpperCase() + word.slice(1))
            .join(' ');
    }

    /**
     * Get guild icon URL
     * @param {object} guildConfig - Guild configuration
     * @returns {string} Guild icon URL
     */
    getGuildIcon(guildConfig) {
        // Use Minecraft head as guild icon
        const username = guildConfig.account.username;
        return `https://minotar.net/helm/${username}/64.png`;
    }

    /**
     * Create info embed
     * @param {string} title - Embed title
     * @param {string} description - Embed description
     * @param {string} color - Color name or hex
     * @returns {EmbedBuilder} Discord embed
     */
    createInfoEmbed(title, description, color = 'system') {
        const embedColor = typeof color === 'string' ? (this.colors[color] || this.colors.system) : color;
        
        return new DiscordEmbedBuilder()
            .setColor(embedColor)
            .setTitle(title)
            .setDescription(description)
            .setTimestamp();
    }

    /**
     * Create error embed
     * @param {string} error - Error message
     * @param {string} context - Error context
     * @returns {EmbedBuilder} Discord embed
     */
    createErrorEmbed(error, context = null) {
        const embed = new DiscordEmbedBuilder()
            .setColor(this.colors.error)
            .setTitle(`${this.emojis.error} Error`)
            .setDescription(error)
            .setTimestamp();

        if (context) {
            embed.addFields({
                name: 'Context',
                value: context,
                inline: false
            });
        }

        return embed;
    }

    /**
     * Update colors configuration
     * @param {object} newColors - New colors configuration
     */
    updateColors(newColors) {
        this.colors = { ...this.colors, ...newColors };
        logger.debug('EmbedBuilder colors updated');
    }

    /**
     * Update emojis configuration
     * @param {object} newEmojis - New emojis configuration
     */
    updateEmojis(newEmojis) {
        this.emojis = { ...this.emojis, ...newEmojis };
        logger.debug('EmbedBuilder emojis updated');
    }
}

module.exports = EmbedBuilder;