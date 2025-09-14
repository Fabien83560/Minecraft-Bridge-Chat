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
        return this.strategies[serverName];
    }

    async executePostConnectStrategy(bot, guildConfig) {
        const serverName = guildConfig.server.serverName;
        const strategy = this.getStrategy(serverName);
        
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
        
        logger.minecraft(`🔄 Executing reconnect strategy for ${serverName}`);
        
        try {
            await strategy.onReconnect(bot, guildConfig);
            logger.minecraft(`✅ Reconnect strategy completed for ${guildConfig.name}`);
        } catch (error) {
            logger.logError(error, `Reconnect strategy failed for ${guildConfig.name}`);
            throw error;
        }
    }

    async handleMessage(bot, message, guildConfig) {
            const serverName = guildConfig.server.serverName;
            const strategy = this.getStrategy(serverName);
            
            try {
                return await strategy.onMessage(bot, message, guildConfig);
            } catch (error) {
                logger.logError(error, `Message handling failed for ${guildConfig.name}`);
                return false;
            }
        }
    }

module.exports = StrategyManager;