// Specific Imports
const logger = require("../../shared/logger");
const HypixelStrategy = require("./hypixelStrategy.js");

class StrategyManager {
    constructor() {
        this.strategies = {
            "Hypixel": new HypixelStrategy()
            // 'Mineplex': new VanillaStrategy(), 
            // '2b2t': new VanillaStrategy(),
            // 'Vanilla': new VanillaStrategy(),
            // 'Custom': new VanillaStrategy()
        };
    }

    getStrategy(serverName) {
        const strategy = this.strategies[serverName];
        if (!strategy) {
            logger.warn(`No strategy found for server: ${serverName}, using default behavior`);
            return null;
        }
        return strategy;
    }

    async executePostConnectStrategy(bot, guildConfig) {
        const serverName = guildConfig.server.serverName;
        const strategy = this.getStrategy(serverName);
        
        if (!strategy) {
            logger.warn(`Skipping post-connect strategy for unknown server: ${serverName}`);
            return;
        }
        
        logger.minecraft(`🎯 Executing post-connect strategy for ${serverName}`);
        
        try {
            await strategy.onConnect(bot, guildConfig);
            logger.minecraft(`✅ Post-connect strategy completed for ${guildConfig.name}`);
        } catch (error) {
            logger.logError(error, `Post-connect strategy failed for ${guildConfig.name}`);
            throw error;
        }
    }

    async executeReconnectStrategy(bot, guildConfig) {
        const serverName = guildConfig.server.serverName;
        const strategy = this.getStrategy(serverName);
        
        if (!strategy) {
            logger.warn(`Skipping reconnect strategy for unknown server: ${serverName}`);
            return;
        }
        
        logger.minecraft(`🔄 Executing reconnect strategy for ${serverName}`);
        
        try {
            await strategy.onReconnect(bot, guildConfig);
            logger.minecraft(`✅ Reconnect strategy completed for ${guildConfig.name}`);
        } catch (error) {
            logger.logError(error, `Reconnect strategy failed for ${guildConfig.name}`);
            throw error;
        }
    }

    /**
     * Handle incoming message through strategy
     * @param {object} bot - Mineflayer bot instance
     * @param {object} message - Raw message from Minecraft
     * @param {object} guildConfig - Guild configuration
     * @returns {object|null} Processed guild message or null if not guild-related
     */
    async handleMessage(bot, message, guildConfig) {
        const serverName = guildConfig.server.serverName;
        const strategy = this.getStrategy(serverName);
        
        if (!strategy) {
            logger.debug(`No strategy for ${serverName}, ignoring message`);
            return null;
        }
        
        try {
            // Let the strategy process the message
            const guildMessageData = await strategy.onMessage(bot, message, guildConfig);
            
            if (guildMessageData) {
                // This is a guild-related message, log it and return for further processing
                logger.debug(`[${guildConfig.name}] Strategy processed guild message: ${guildMessageData.type}`);
                return guildMessageData;
            }
            
            // Not a guild message, ignore it
            return null;
            
        } catch (error) {
            logger.logError(error, `Message handling failed for ${guildConfig.name}`);
            return null;
        }
    }

    /**
     * Check if a message is guild-related without full processing
     * @param {object} message - Raw message from Minecraft
     * @param {object} guildConfig - Guild configuration
     * @returns {boolean} Whether message is guild-related
     */
    isGuildMessage(message, guildConfig) {
        const serverName = guildConfig.server.serverName;
        const strategy = this.getStrategy(serverName);
        
        if (!strategy) {
            return false;
        }
        
        try {
            const messageText = message.toString();
            return strategy.isGuildMessage(messageText);
        } catch (error) {
            logger.logError(error, `Error checking if message is guild message for ${guildConfig.name}`);
            return false;
        }
    }
}

module.exports = StrategyManager;