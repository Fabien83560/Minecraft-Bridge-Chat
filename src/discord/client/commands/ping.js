// Globals Imports
const { SlashCommandBuilder } = require('discord.js');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('ping')
        .setDescription('Replies with Pong! and shows bot latency'),
    
    // Permission level (optional)
    permission: 'user', // 'user', 'mod', 'admin'
    
    async execute(interaction) {
        // Get the timestamp when the command was sent
        const sent = await interaction.reply({ 
            content: 'Pinging...', 
            fetchReply: true 
        });
        
        // Calculate latency
        const latency = sent.createdTimestamp - interaction.createdTimestamp;
        const apiLatency = Math.round(interaction.client.ws.ping);
        
        // Update the reply with latency information
        await interaction.editReply({
            content: `🏓 Pong!\n` +
                    `**Bot Latency:** ${latency}ms\n` +
                    `**API Latency:** ${apiLatency}ms`
        });
    },
};