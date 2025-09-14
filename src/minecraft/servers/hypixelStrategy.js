// Specific Imports
const logger = require("../../shared/logger");

class HypixelStrategy {
    constructor() {
        this.name = "HypixelStrategy";
        this.limboDelay = 3000;
    }

    async onConnect(bot, guildConfig) {
        logger.minecraft(`🏰 Hypixel connection strategy for ${guildConfig.name}`);
        
        // Wait for connection to stabilize
        await this.wait(this.limboDelay);
        
        // Go to limbo to avoid disconnections
        await this.goToLimbo(bot, guildConfig);
    }

    async onReconnect(bot, guildConfig) {
        logger.minecraft(`🔄 Hypixel reconnection strategy for ${guildConfig.name}`);
        
        // Wait longer after reconnection
        await this.wait(this.limboDelay);
        
        // Always return to limbo after reconnection
        await this.goToLimbo(bot, guildConfig);
    }

    async goToLimbo(bot, guildConfig, retryCount = 0) {
        try {
            logger.minecraft(`🌌 Going to limbo for ${guildConfig.name}...`);
            
            // Send limbo command
            bot.chat('/limbo');
            
            // Wait for confirmation
            await this.wait(this.limboDelay);
            
            logger.minecraft(`✅ Successfully went to limbo for ${guildConfig.name}`);
            
        } catch (error) {
            if (retryCount < this.maxRetries) {
                logger.minecraft(`⚠️ Failed to go to limbo, retrying... (${retryCount + 1}/${this.maxRetries})`);
                await this.wait(this.limboDelay);
                return this.goToLimbo(bot, guildConfig, retryCount + 1);
            } else {
                logger.logError(error, `Failed to go to limbo for ${guildConfig.name} after ${this.maxRetries} retries`);
                throw error;
            }
        }
    }

    async onGuildJoin(bot, guildConfig) {
        // After joining a guild, stay in limbo
        logger.minecraft(`🏰 Guild joined, staying in limbo for ${guildConfig.name}`);
        await this.wait(this.limboDelay);
        await this.goToLimbo(bot, guildConfig);
    }

    async onMessage(bot, message, guildConfig) {
        const messageText = message.toString();

        // Handle guild messages
        if (this.isGuildMessage(messageText)) {
            logger.debug(`Guild message from ${guildConfig.name}: ${messageText}`);
            return true;
        }

        // Handle system messages
        if (this.isSystemMessage(messageText)) {
            logger.debug(`System message from ${guildConfig.name}: ${messageText}`);
            return true;
        }

        return false;
    }

    isGuildMessage(message) {
        // Hypixel guild message patterns
        const guildPatterns = [
            'Guild >',
            'G >',
            '[Guild]',
            '§2Guild >',
            '§aGuild >'
        ];
        
        return guildPatterns.some(pattern => message.includes(pattern));
    }

    isSystemMessage(message) {
        // Hypixel system message patterns
        const systemPatterns = [
            'joined the guild',
            'left the guild',
            'was promoted to',
            'was demoted to',
            'was kicked from the guild',
            'Online Members:'
        ];
        
        return systemPatterns.some(pattern => message.includes(pattern));
    }

    wait(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
}

module.exports = HypixelStrategy;