// Specific Imports
const logger = require('./logger');
const { getTemplateLoader } = require('../config/TemplateLoader.js');

class MessageFormatter {
    constructor(config = {}) {
        this.config = {
            showTags: config.showTags || false,
            showSourceTag: config.showSourceTag || true,
            enableDebugLogging: config.enableDebugLogging || false,
            maxMessageLength: config.maxMessageLength || 256,
            fallbackToBasic: config.fallbackToBasic !== false, // true by default
            ...config
        };

        this.templateLoader = getTemplateLoader();
        
        // Performance cache for formatted messages
        this.formatCache = new Map();
        this.cacheMaxSize = 1000;
        
        logger.debug('MessageFormatter initialized with config:', this.config);
    }

    /**
     * Format a guild chat message for inter-guild transfer
     * @param {object} messageData - Parsed message data
     * @param {object} sourceGuildConfig - Source guild configuration
     * @param {object} targetGuildConfig - Target guild configuration
     * @param {string} platform - Target platform (messagesToMinecraft, messagesToDiscord)
     * @returns {string|null} Formatted message or null
     */
    formatGuildMessage(messageData, sourceGuildConfig, targetGuildConfig, platform = 'messagesToMinecraft') {
        try {
            const variables = this.buildMessageVariables(messageData, sourceGuildConfig, targetGuildConfig);
            const chatType = messageData.chatType || 'guild';
            
            const template = this.templateLoader.getBestTemplate(
                platform, 
                targetGuildConfig.server.serverName, 
                chatType, 
                this.config
            );

            if (!template) {
                logger.warn(`No template found for ${platform}/${targetGuildConfig.server.serverName}/${chatType}`);
                return this.createFallbackMessage(messageData, sourceGuildConfig);
            }

            const formattedMessage = this.substituteVariables(template, variables);
            
            if (this.config.enableDebugLogging) {
                logger.debug(`Formatted ${chatType} message: "${formattedMessage}"`);
            }

            return this.postProcessMessage(formattedMessage, platform);

        } catch (error) {
            logger.logError(error, `Error formatting guild message from ${sourceGuildConfig.name}`);
            return this.createFallbackMessage(messageData, sourceGuildConfig);
        }
    }

    /**
     * Format a guild event for inter-guild transfer
     * @param {object} eventData - Parsed event data
     * @param {object} sourceGuildConfig - Source guild configuration
     * @param {object} targetGuildConfig - Target guild configuration
     * @param {string} platform - Target platform (messagesToMinecraft, messagesToDiscord)
     * @returns {string|null} Formatted event message or null
     */
    formatGuildEvent(eventData, sourceGuildConfig, targetGuildConfig, platform = 'messagesToMinecraft') {
        try {
            const variables = this.buildEventVariables(eventData, sourceGuildConfig, targetGuildConfig);
            
            const template = this.templateLoader.getEventTemplate(
                platform,
                targetGuildConfig.server.serverName,
                eventData.type,
                this.config
            );

            if (!template) {
                logger.warn(`No event template found for ${platform}/${targetGuildConfig.server.serverName}/${eventData.type}`);
                return this.createFallbackEventMessage(eventData, sourceGuildConfig);
            }

            const formattedMessage = this.substituteVariables(template, variables);
            
            if (this.config.enableDebugLogging) {
                logger.debug(`Formatted ${eventData.type} event: "${formattedMessage}"`);
            }

            return this.postProcessMessage(formattedMessage, platform);

        } catch (error) {
            logger.logError(error, `Error formatting guild event from ${sourceGuildConfig.name}`);
            return this.createFallbackEventMessage(eventData, sourceGuildConfig);
        }
    }

    /**
     * Format a system message
     * @param {string} type - System message type
     * @param {object} data - System message data
     * @param {object} guildConfig - Guild configuration
     * @param {string} platform - Target platform
     * @returns {string|null} Formatted system message or null
     */
    formatSystemMessage(type, data, guildConfig, platform = 'messagesToMinecraft') {
        try {
            const variables = this.buildSystemVariables(type, data, guildConfig);
            
            const template = this.templateLoader.getTemplate(
                platform,
                guildConfig.server.serverName,
                'system',
                type
            );

            if (!template) {
                logger.warn(`No system template found for ${platform}/${guildConfig.server.serverName}/system/${type}`);
                return `[SYSTEM] ${JSON.stringify(data)}`;
            }

            const formattedMessage = this.substituteVariables(template, variables);
            
            if (this.config.enableDebugLogging) {
                logger.debug(`Formatted system message: "${formattedMessage}"`);
            }

            return this.postProcessMessage(formattedMessage, platform);

        } catch (error) {
            logger.logError(error, `Error formatting system message: ${type}`);
            return `[SYSTEM ERROR] ${type}`;
        }
    }

    /**
     * Build variables for message formatting
     * @param {object} messageData - Parsed message data
     * @param {object} sourceGuildConfig - Source guild configuration
     * @param {object} targetGuildConfig - Target guild configuration
     * @returns {object} Variables object
     */
    buildMessageVariables(messageData, sourceGuildConfig, targetGuildConfig) {
        const variables = {
            username: messageData.username || 'Unknown',
            message: messageData.message || '',
            chatType: messageData.chatType || 'guild',
            rank: messageData.rank || null,
            
            // Source guild information
            sourceGuildName: sourceGuildConfig.name,
            sourceGuildTag: sourceGuildConfig.tag,
            sourceGuildId: sourceGuildConfig.id,
            
            // Target guild information  
            targetGuildName: targetGuildConfig.name,
            targetGuildTag: targetGuildConfig.tag,
            targetGuildId: targetGuildConfig.id,
            
            // Generic guild info (for templates that don't specify source/target)
            guildName: sourceGuildConfig.name,
            guildTag: sourceGuildConfig.tag,
            guildId: sourceGuildConfig.id,
            
            // Timestamp
            timestamp: new Date().toLocaleTimeString(),
            date: new Date().toLocaleDateString()
        };

        // Add conditional tag based on configuration
        if (this.config.showTags && sourceGuildConfig.tag) {
            variables.tag = `[${sourceGuildConfig.tag}]`;
        } else {
            variables.tag = '';
        }

        return variables;
    }

    /**
     * Build variables for event formatting
     * @param {object} eventData - Parsed event data
     * @param {object} sourceGuildConfig - Source guild configuration
     * @param {object} targetGuildConfig - Target guild configuration
     * @returns {object} Variables object
     */
    buildEventVariables(eventData, sourceGuildConfig, targetGuildConfig) {
        const variables = {
            // Event basic info
            eventType: eventData.type,
            username: eventData.username || 'Unknown',
            
            // Source guild information
            sourceGuildName: sourceGuildConfig.name,
            sourceGuildTag: sourceGuildConfig.tag,
            sourceGuildId: sourceGuildConfig.id,
            
            // Target guild information
            targetGuildName: targetGuildConfig.name,
            targetGuildTag: targetGuildConfig.tag,
            targetGuildId: targetGuildConfig.id,
            
            // Generic guild info
            guildName: sourceGuildConfig.name,
            guildTag: sourceGuildConfig.tag,
            guildId: sourceGuildConfig.id,
            
            // Timestamp
            timestamp: new Date().toLocaleTimeString(),
            date: new Date().toLocaleDateString()
        };

        // Add conditional tag
        if (this.config.showTags && sourceGuildConfig.tag) {
            variables.tag = `[${sourceGuildConfig.tag}]`;
        } else {
            variables.tag = '';
        }

        // Add event-specific variables
        switch (eventData.type) {
            case 'join':
                // Join events don't need extra variables usually
                break;
            
            case 'disconnect':
                break;
                
            case 'leave':
                variables.reason = eventData.reason ? ` (${eventData.reason})` : '';
                break;
            
            case 'welcome':
                break;

            case 'kick':
                variables.reason = eventData.reason ? ` for: ${eventData.reason}` : '';
                break;
                
            case 'promote':
                variables.toRank = eventData.toRank || 'Unknown';
                variables.fromRank = eventData.fromRank || 'Unknown';
                variables.promoter = eventData.promoter || null;
                break;
                
            case 'demote':
                variables.toRank = eventData.toRank || 'Unknown';
                variables.fromRank = eventData.fromRank || 'Unknown';
                variables.demoter = eventData.demoter || null;
                break;
                
            case 'level':
                variables.level = eventData.level || 1;
                variables.previousLevel = eventData.previousLevel || 1;
                break;
                
            case 'motd':
                variables.changer = eventData.changer || 'Unknown';
                variables.motd = eventData.motd || '';
                break;
                
            case 'invite':
                variables.inviter = eventData.inviter || 'Unknown';
                variables.invited = eventData.invited || 'Unknown';
                break;
                
            default:
                // Add any additional data from the event
                Object.keys(eventData).forEach(key => {
                    if (!variables.hasOwnProperty(key) && typeof eventData[key] !== 'object') {
                        variables[key] = eventData[key];
                    }
                });
                break;
        }

        return variables;
    }

    /**
     * Build variables for system message formatting
     * @param {string} type - System message type
     * @param {object} data - System message data
     * @param {object} guildConfig - Guild configuration
     * @returns {object} Variables object
     */
    buildSystemVariables(type, data, guildConfig) {
        const variables = {
            type: type,
            guildName: guildConfig.name,
            guildTag: guildConfig.tag,
            guildId: guildConfig.id,
            timestamp: new Date().toLocaleTimeString(),
            date: new Date().toLocaleDateString()
        };

        // Add data properties
        if (data && typeof data === 'object') {
            Object.keys(data).forEach(key => {
                if (typeof data[key] !== 'object') {
                    variables[key] = data[key];
                }
            });
        }

        return variables;
    }

    /**
     * Substitute variables in template string
     * @param {string} template - Template string with {variable} placeholders
     * @param {object} variables - Variables to substitute
     * @returns {string} String with substituted variables
     */
    substituteVariables(template, variables) {
        if (!template || typeof template !== 'string') {
            return template;
        }

        let result = template;
        const defaults = this.templateLoader.getDefaults('placeholders');
        
        // Replace all {variable} patterns
        result = result.replace(/\{([^}]+)\}/g, (match, variableName) => {
            if (variables.hasOwnProperty(variableName)) {
                return variables[variableName] || '';
            } else if (defaults.hasOwnProperty(variableName)) {
                return defaults[variableName];
            } else {
                // Keep the placeholder if variable not found
                return match;
            }
        });

        return result;
    }

    /**
     * Post-process message based on platform
     * @param {string} message - Formatted message
     * @param {string} platform - Target platform
     * @returns {string} Post-processed message
     */
    postProcessMessage(message, platform) {
        if (!message) return message;

        let processed = message;

        // Remove empty tags or double spaces
        processed = processed.replace(/\s+/g, ' ').trim();
        processed = processed.replace(/\[\s*\]/g, ''); // Remove empty brackets
        processed = processed.replace(/\(\s*\)/g, ''); // Remove empty parentheses

        // Platform-specific processing
        if (platform === 'messagesToMinecraft') {
            // Truncate for Minecraft character limits
            if (processed.length > this.config.maxMessageLength) {
                processed = processed.substring(0, this.config.maxMessageLength - 3) + '...';
            }
            
            // Remove Discord markdown
            processed = this.removeDiscordMarkdown(processed);
            
        } else if (platform === 'messagesToDiscord') {
            // Discord has a 2000 character limit but we'll use a smaller limit for readability
            const discordLimit = Math.min(this.config.maxMessageLength, 2000);
            if (processed.length > discordLimit) {
                processed = processed.substring(0, discordLimit - 3) + '...';
            }
            
            // Escape special Discord characters if needed
            // (Discord markdown is intentionally kept for formatting)
        }

        return processed;
    }

    /**
     * Remove Discord markdown formatting
     * @param {string} text - Text with Discord markdown
     * @returns {string} Text without markdown
     */
    removeDiscordMarkdown(text) {
        if (!text || typeof text !== 'string') {
            return text;
        }

        return text
            .replace(/\*\*(.*?)\*\*/g, '$1')  // Bold
            .replace(/\*(.*?)\*/g, '$1')      // Italic  
            .replace(/__(.*?)__/g, '$1')      // Underline
            .replace(/~~(.*?)~~/g, '$1')      // Strikethrough
            .replace(/`(.*?)`/g, '$1')        // Inline code
            .replace(/```[\s\S]*?```/g, '')   // Code blocks
            .replace(/\|\|(.*?)\|\|/g, '$1'); // Spoilers
    }

    /**
     * Create fallback message when template fails
     * @param {object} messageData - Message data
     * @param {object} sourceGuildConfig - Source guild config
     * @returns {string} Fallback message
     */
    createFallbackMessage(messageData, sourceGuildConfig) {
        if (!this.config.fallbackToBasic) {
            return null;
        }

        const prefix = this.config.showSourceTag ? `[${sourceGuildConfig.tag}] ` : '';
        const tag = this.config.showTags ? ` [${sourceGuildConfig.tag}]` : '';
        
        return `${prefix}${messageData.username}${tag}: ${messageData.message}`;
    }

    /**
     * Create fallback event message when template fails
     * @param {object} eventData - Event data
     * @param {object} sourceGuildConfig - Source guild config
     * @returns {string} Fallback event message
     */
    createFallbackEventMessage(eventData, sourceGuildConfig) {
        if (!this.config.fallbackToBasic) {
            return null;
        }

        const prefix = this.config.showSourceTag ? `[${sourceGuildConfig.tag}] ` : '';
        const tag = this.config.showTags ? ` [${sourceGuildConfig.tag}]` : '';
        
        switch (eventData.type) {
            case 'welcome':
                return `${prefix}${eventData.username}${tag} joined the guild!`;
            case 'leave':
                return `${prefix}${eventData.username}${tag} left the guild`;
            case 'kick':
                return `${prefix}${eventData.username}${tag} was kicked from the guild`;
            case 'promote':
                return `${prefix}${eventData.username}${tag} was promoted to ${eventData.toRank}`;
            case 'demote':
                return `${prefix}${eventData.username}${tag} was demoted to ${eventData.toRank}`;
            case 'level':
                return `${prefix}Guild reached level ${eventData.level}!`;
            default:
                return `${prefix}Guild event: ${eventData.type}`;
        }
    }

    /**
     * Update formatter configuration
     * @param {object} newConfig - New configuration options
     */
    updateConfig(newConfig) {
        this.config = { ...this.config, ...newConfig };
        this.formatCache.clear(); // Clear cache as configuration changed
        
        logger.debug('MessageFormatter configuration updated:', this.config);
    }

    /**
     * Get current configuration
     * @returns {object} Current configuration
     */
    getConfig() {
        return { ...this.config };
    }

    /**
     * Clear formatting cache
     */
    clearCache() {
        this.formatCache.clear();
        logger.debug('MessageFormatter cache cleared');
    }

    /**
     * Get formatter statistics
     * @returns {object} Formatter statistics
     */
    getStatistics() {
        return {
            cacheSize: this.formatCache.size,
            cacheMaxSize: this.cacheMaxSize,
            config: this.getConfig(),
            templateStats: this.templateLoader.getStatistics()
        };
    }

    /**
     * Test message formatting (for debugging)
     * @param {string} platform - Target platform
     * @param {string} serverName - Server name
     * @param {string} category - Template category
     * @param {object} testData - Test data
     * @returns {object} Test results
     */
    testFormatting(platform, serverName, category, testData = {}) {
        const template = this.templateLoader.getBestTemplate(platform, serverName, category, this.config);
        
        // Create test variables
        const defaults = this.templateLoader.getDefaults('placeholders');
        const testVariables = { ...defaults, ...testData };
        
        const templateTest = this.templateLoader.testTemplate(template, testVariables);
        
        return {
            platform: platform,
            serverName: serverName,
            category: category,
            template: template,
            config: this.config,
            templateTest: templateTest,
            finalResult: templateTest.valid ? 
                this.postProcessMessage(templateTest.result, platform) : 
                null
        };
    }
}

module.exports = MessageFormatter;