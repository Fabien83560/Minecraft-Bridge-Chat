/**
 * Message Formatter - Template-Based Message and Event Formatting System
 * 
 * This class provides a centralized system for formatting messages and events when bridging
 * between Minecraft guilds and Discord. It uses a template-based approach with variable
 * substitution to create consistent, customizable message formats across different platforms
 * and server types.
 * 
 * The formatter provides:
 * - Template-based message formatting with variable substitution
 * - Support for multiple platforms (Minecraft, Discord)
 * - Server-specific template selection (Hypixel, Vanilla, etc.)
 * - Guild message formatting with source/target awareness
 * - Event formatting for all guild event types
 * - System message formatting
 * - Platform-specific post-processing (character limits, markdown handling)
 * - Fallback message generation when templates fail
 * - Performance caching for frequently formatted messages
 * - Configurable tag display and formatting options
 * 
 * Template variable system:
 * - Message variables: username, message, chatType, rank, guildName, guildTag, timestamp
 * - Event variables: eventType, username, toRank, fromRank, level, motd, promoter, demoter
 * - Guild variables: sourceGuildName, targetGuildName, sourceGuildTag, targetGuildTag
 * - Conditional variables: tag (based on showTags config)
 * 
 * Configuration options:
 * - showTags: Display guild tags in messages (default: false)
 * - showSourceTag: Show source guild tag prefix (default: true)
 * - enableDebugLogging: Enable detailed format logging (default: false)
 * - maxMessageLength: Maximum message length (default: 256)
 * - fallbackToBasic: Use fallback formatting on template failure (default: true)
 * 
 * Platform-specific processing:
 * - Minecraft: Character limit enforcement, Discord markdown removal
 * - Discord: Extended character limit (2000), markdown preservation
 * 
 * @author Fabien83560
 * @version 1.0.0
 * @license ISC
 */

// Specific Imports
const logger = require('./logger');
const { getTemplateLoader } = require('../config/TemplateLoader.js');

/**
 * MessageFormatter - Format messages and events using templates
 * 
 * Utility class that formats guild messages, events, and system messages using
 * configurable templates with variable substitution. Handles platform-specific
 * processing and provides fallback formatting when templates are unavailable.
 * 
 * @class
 */
class MessageFormatter {
    /**
     * Create a new MessageFormatter instance
     * 
     * Initializes the formatter with configuration options and sets up the template
     * loader and performance cache. Default configuration values are applied for any
     * options not explicitly provided.
     * 
     * @param {object} [config={}] - Formatter configuration options
     * @param {boolean} [config.showTags=false] - Display guild tags in formatted messages
     * @param {boolean} [config.showSourceTag=true] - Show source guild tag as prefix
     * @param {boolean} [config.enableDebugLogging=false] - Enable detailed debug logging
     * @param {number} [config.maxMessageLength=256] - Maximum message length before truncation
     * @param {boolean} [config.fallbackToBasic=true] - Use fallback formatting on template failure
     * 
     * @example
     * const formatter = new MessageFormatter({
     *   showTags: true,
     *   maxMessageLength: 200,
     *   enableDebugLogging: true
     * });
     */
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
     * 
     * Formats a guild chat message (guild or officer chat) using appropriate templates
     * for the target platform and server type. Handles variable substitution, platform-
     * specific post-processing, and provides fallback formatting on template failure.
     * 
     * The method performs:
     * 1. Variable building from message data and guild configs
     * 2. Template selection based on platform, server, and chat type
     * 3. Variable substitution in template
     * 4. Platform-specific post-processing
     * 5. Fallback formatting if template unavailable or error occurs
     * 
     * @param {object} messageData - Parsed message data from source guild
     * @param {string} messageData.username - Username of message sender
     * @param {string} messageData.message - Message content
     * @param {string} [messageData.chatType='guild'] - Chat type ('guild' or 'officer')
     * @param {string} [messageData.rank] - Player's guild rank (optional)
     * @param {object} sourceGuildConfig - Source guild configuration
     * @param {string} sourceGuildConfig.name - Source guild name
     * @param {string} sourceGuildConfig.tag - Source guild tag
     * @param {string} sourceGuildConfig.id - Source guild ID
     * @param {object} targetGuildConfig - Target guild configuration
     * @param {string} targetGuildConfig.name - Target guild name
     * @param {object} targetGuildConfig.server - Target server configuration
     * @param {string} targetGuildConfig.server.serverName - Server type (e.g., 'Hypixel', 'Vanilla')
     * @param {string} [platform='messagesToMinecraft'] - Target platform ('messagesToMinecraft' or 'messagesToDiscord')
     * @returns {string|null} Formatted message string or null on failure without fallback
     * 
     * @example
     * const formatted = formatter.formatGuildMessage(
     *   { username: "Player123", message: "Hello!", chatType: "guild" },
     *   sourceGuild,
     *   targetGuild,
     *   'messagesToMinecraft'
     * );
     * // Returns: "[GuildA] Player123: Hello!"
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
     * 
     * Formats a guild event (join, leave, promote, demote, etc.) using appropriate
     * event templates for the target platform and server type. Handles event-specific
     * variable building and provides fallback formatting.
     * 
     * Supported event types:
     * - join/welcome: Player joining guild
     * - leave: Player leaving guild
     * - kick: Player kicked from guild
     * - promote: Player promoted with rank change
     * - demote: Player demoted with rank change
     * - level: Guild level up
     * - motd: MOTD change
     * - invite: Guild invitation
     * 
     * @param {object} eventData - Parsed event data from source guild
     * @param {string} eventData.type - Event type identifier
     * @param {string} [eventData.username] - Username involved in event
     * @param {string} [eventData.toRank] - New rank (promote/demote)
     * @param {string} [eventData.fromRank] - Previous rank (promote/demote)
     * @param {number} [eventData.level] - Guild level (level event)
     * @param {string} [eventData.motd] - New MOTD (motd event)
     * @param {string} [eventData.reason] - Kick/leave reason
     * @param {object} sourceGuildConfig - Source guild configuration
     * @param {string} sourceGuildConfig.name - Source guild name
     * @param {string} sourceGuildConfig.tag - Source guild tag
     * @param {object} targetGuildConfig - Target guild configuration
     * @param {object} targetGuildConfig.server - Target server configuration
     * @param {string} targetGuildConfig.server.serverName - Server type
     * @param {string} [platform='messagesToMinecraft'] - Target platform
     * @returns {string|null} Formatted event message or null on failure without fallback
     * 
     * @example
     * const formatted = formatter.formatGuildEvent(
     *   { type: "promote", username: "Player123", fromRank: "Member", toRank: "Officer" },
     *   sourceGuild,
     *   targetGuild,
     *   'messagesToDiscord'
     * );
     * // Returns: "[GuildA] Player123 was promoted to Officer!"
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
                // 'online' is the /g online command output rather than a guild event, so
                // it legitimately has no template. Warning on it produced thousands of
                // entries that buried the warnings that actually mattered.
                if (!MessageFormatter.NON_BRIDGEABLE_EVENTS.includes(eventData.type)) {
                    logger.warn(
                        `No event template found for ${platform}/${targetGuildConfig.server.serverName}/${eventData.type}` +
                        ` - falling back to basic wording. Raw: "${(eventData.raw || '').substring(0, 120)}"`
                    );
                }

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
     * 
     * Formats system messages and notifications using system templates. System messages
     * are used for internal notifications, status updates, and other non-chat content.
     * 
     * @param {string} type - System message type identifier
     * @param {object} data - System message data
     * @param {string} [data.message] - Message content
     * @param {*} [data.*] - Additional type-specific data properties
     * @param {object} guildConfig - Guild configuration
     * @param {string} guildConfig.name - Guild name
     * @param {string} guildConfig.tag - Guild tag
     * @param {string} guildConfig.id - Guild ID
     * @param {object} guildConfig.server - Server configuration
     * @param {string} guildConfig.server.serverName - Server type
     * @param {string} [platform='messagesToMinecraft'] - Target platform
     * @returns {string|null} Formatted system message or fallback string
     * 
     * @example
     * const formatted = formatter.formatSystemMessage(
     *   'connection',
     *   { status: 'connected', attempt: 1 },
     *   guildConfig,
     *   'messagesToDiscord'
     * );
     * // Returns: "[SYSTEM] Guild MyGuild connected (attempt 1)"
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
     * 
     * Constructs a complete variables object for message template substitution.
     * Includes message data, source/target guild information, timestamps, and
     * conditional tag display based on configuration.
     * 
     * @param {object} messageData - Parsed message data
     * @param {string} messageData.username - Message sender username
     * @param {string} messageData.message - Message content
     * @param {string} [messageData.chatType='guild'] - Chat type
     * @param {string} [messageData.rank] - Player rank (optional)
     * @param {object} sourceGuildConfig - Source guild configuration
     * @param {string} sourceGuildConfig.name - Source guild name
     * @param {string} sourceGuildConfig.tag - Source guild tag
     * @param {string} sourceGuildConfig.id - Source guild ID
     * @param {object} targetGuildConfig - Target guild configuration
     * @param {string} targetGuildConfig.name - Target guild name
     * @param {string} targetGuildConfig.tag - Target guild tag
     * @param {string} targetGuildConfig.id - Target guild ID
     * @returns {object} Variables object for template substitution
     * 
     * @example
     * const variables = formatter.buildMessageVariables(
     *   { username: "Player", message: "Hi", chatType: "guild" },
     *   sourceGuild,
     *   targetGuild
     * );
     * // Returns: { username: "Player", message: "Hi", chatType: "guild", 
     * //            sourceGuildName: "GuildA", targetGuildName: "GuildB", ... }
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
     * 
     * Constructs a complete variables object for event template substitution.
     * Includes event type, username, guild information, and event-specific data
     * based on the event type (rank changes, levels, MOTD, etc.).
     * 
     * Event-specific variables by type:
     * - join/welcome: Basic event info only
     * - leave: reason (optional)
     * - kick: reason (optional)
     * - promote: toRank, fromRank, promoter (optional)
     * - demote: toRank, fromRank, demoter (optional)
     * - level: level, previousLevel
     * - motd: changer, motd
     * - invite: inviter, invited
     * 
     * @param {object} eventData - Parsed event data
     * @param {string} eventData.type - Event type
     * @param {string} [eventData.username] - Username involved
     * @param {object} sourceGuildConfig - Source guild configuration
     * @param {string} sourceGuildConfig.name - Source guild name
     * @param {string} sourceGuildConfig.tag - Source guild tag
     * @param {string} sourceGuildConfig.id - Source guild ID
     * @param {object} targetGuildConfig - Target guild configuration
     * @param {string} targetGuildConfig.name - Target guild name
     * @param {string} targetGuildConfig.tag - Target guild tag
     * @param {string} targetGuildConfig.id - Target guild ID
     * @returns {object} Variables object for template substitution
     * 
     * @example
     * const variables = formatter.buildEventVariables(
     *   { type: "promote", username: "Player", fromRank: "Member", toRank: "Officer" },
     *   sourceGuild,
     *   targetGuild
     * );
     * // Returns: { eventType: "promote", username: "Player", toRank: "Officer", ... }
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
     * 
     * Constructs a variables object for system message template substitution.
     * Includes system message type, guild information, timestamps, and all
     * non-object properties from the data parameter.
     * 
     * @param {string} type - System message type
     * @param {object} data - System message data
     * @param {object} guildConfig - Guild configuration
     * @param {string} guildConfig.name - Guild name
     * @param {string} guildConfig.tag - Guild tag
     * @param {string} guildConfig.id - Guild ID
     * @returns {object} Variables object for template substitution
     * 
     * @example
     * const variables = formatter.buildSystemVariables(
     *   'status',
     *   { connected: true, attempt: 1 },
     *   guildConfig
     * );
     * // Returns: { type: "status", connected: true, attempt: 1, guildName: "...", ... }
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
     * 
     * Performs variable substitution on a template string by replacing {variableName}
     * placeholders with actual values from the variables object. Falls back to default
     * placeholder values if a variable is not found. Keeps original placeholder if
     * neither variable nor default exists.
     * 
     * Placeholder format: {variableName}
     * 
     * @param {string} template - Template string with {variable} placeholders
     * @param {object} variables - Variables to substitute into template
     * @returns {string} String with variables substituted
     * 
     * @example
     * const template = "{username} says: {message}";
     * const variables = { username: "Player123", message: "Hello!" };
     * const result = formatter.substituteVariables(template, variables);
     * // Returns: "Player123 says: Hello!"
     * 
     * @example
     * // With missing variable
     * const template = "User: {username}, Level: {level}";
     * const variables = { username: "Player123" };
     * const result = formatter.substituteVariables(template, variables);
     * // Returns: "User: Player123, Level: {level}" (or default if defined)
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
     * 
     * Performs platform-specific post-processing on formatted messages including:
     * - Cleanup: Remove empty tags/brackets, normalize whitespace
     * - Minecraft: Character limit enforcement, Discord markdown removal
     * - Discord: Extended character limit, markdown preservation
     * 
     * Character limits:
     * - Minecraft: config.maxMessageLength (default 256)
     * - Discord: min(config.maxMessageLength, 2000)
     * 
     * @param {string} message - Formatted message to post-process
     * @param {string} platform - Target platform ('messagesToMinecraft' or 'messagesToDiscord')
     * @returns {string} Post-processed message ready for delivery
     * 
     * @example
     * const message = "  [GuildA]  Player123  : Hello!  ";
     * const processed = formatter.postProcessMessage(message, 'messagesToMinecraft');
     * // Returns: "[GuildA] Player123 : Hello!" (cleaned, markdown removed if any)
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
     * 
     * Strips all Discord markdown formatting from text, converting formatted text
     * to plain text. Used when sending Discord messages to Minecraft where markdown
     * is not supported and would display as raw syntax.
     * 
     * Removed markdown types:
     * - Bold: **text** → text
     * - Italic: *text* → text
     * - Underline: __text__ → text
     * - Strikethrough: ~~text~~ → text
     * - Inline code: `code` → code
     * - Code blocks: ```code``` → (removed entirely)
     * - Spoilers: ||text|| → text
     * 
     * @param {string} text - Text with Discord markdown
     * @returns {string} Text without any markdown formatting
     * 
     * @example
     * const marked = "**Bold** and *italic* with `code`";
     * const plain = formatter.removeDiscordMarkdown(marked);
     * // Returns: "Bold and italic with code"
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
     * 
     * Generates a simple fallback message format when template loading or formatting
     * fails. Uses basic string concatenation with optional tag display based on
     * configuration. Returns null if fallbackToBasic is disabled.
     * 
     * Fallback format: [SourceTag] username [tag]: message
     * 
     * @param {object} messageData - Message data
     * @param {string} messageData.username - Username of sender
     * @param {string} messageData.message - Message content
     * @param {object} sourceGuildConfig - Source guild configuration
     * @param {string} sourceGuildConfig.tag - Source guild tag
     * @returns {string|null} Fallback message or null if disabled
     * 
     * @example
     * const fallback = formatter.createFallbackMessage(
     *   { username: "Player", message: "Hi!" },
     *   { tag: "GLD" }
     * );
     * // Returns: "[GLD] Player: Hi!" (if showSourceTag is true)
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
     * 
     * Generates a simple fallback event message format when event template loading
     * or formatting fails. Provides basic event descriptions with optional guild tag
     * display. Returns null if fallbackToBasic is disabled.
     * 
     * This is a safety net, not a formatting path. Every event type that should reach a
     * destination has a template in templates.json; reaching this method means a
     * template is missing, which is why formatGuildEvent logs a warning first. The
     * fallback covers the same set of types so a missing template degrades the wording
     * rather than losing the event.
     *
     * Types with no meaningful fallback return "unknown_event_type", which callers
     * treat as "do not send". Only genuinely unbridgeable types should land there.
     *
     * @param {object} eventData - Event data
     * @param {string} eventData.type - Event type
     * @param {string} [eventData.username] - Username involved
     * @param {string} [eventData.toRank] - New rank (promote/demote)
     * @param {number} [eventData.level] - Guild level (level event)
     * @param {string} [eventData.changer] - Who changed the MOTD (motd event)
     * @param {string} [eventData.motd] - New MOTD text (motd event)
     * @param {string} [eventData.message] - Free-form detail (misc event)
     * @param {object} sourceGuildConfig - Source guild configuration
     * @param {string} sourceGuildConfig.tag - Source guild tag
     * @returns {string|null} Fallback event message or null if disabled
     *
     * @example
     * const fallback = formatter.createFallbackEventMessage(
     *   { type: "promote", username: "Player", toRank: "Officer" },
     *   { tag: "GLD" }
     * );
     * // Returns: "[GLD] Player was promoted to Officer"
     */
    createFallbackEventMessage(eventData, sourceGuildConfig) {
        if (!this.config.fallbackToBasic) {
            return null;
        }

        const prefix = this.config.showSourceTag ? `[${sourceGuildConfig.tag}] ` : '';
        const tag = this.config.showTags ? ` [${sourceGuildConfig.tag}]` : '';

        switch (eventData.type) {
            case 'welcome':
                return `${prefix}${eventData.username}${tag} a rejoint la guilde !`;
            case 'leave':
                return `${prefix}${eventData.username}${tag} a quitté la guilde`;
            case 'kick':
                return `${prefix}${eventData.username}${tag} a été expulsé de la guilde`;
            case 'promote':
                return `${prefix}${eventData.username}${tag} a été promu au rang ${eventData.toRank}`;
            case 'demote':
                return `${prefix}${eventData.username}${tag} a été rétrogradé au rang ${eventData.toRank}`;
            case 'level':
                return `${prefix}La guilde a atteint le niveau ${eventData.level} !`;
            case 'join':
                return `${prefix}${eventData.username}${tag} s'est connecté`;
            case 'disconnect':
                return `${prefix}${eventData.username}${tag} s'est déconnecté`;
            case 'invite':
                return `${prefix}${eventData.username}${tag} a été invité dans la guilde`;
            case 'motd':
                return `${prefix}${eventData.changer || 'Quelqu\'un'}${tag} a modifié le MOTD : ${eventData.motd || ''}`.trim();
            case 'misc':
                return `${prefix}Guilde mise à jour : ${eventData.message || eventData.raw || ''}`.trim();
            default:
                // 'online' lands here: it is the /g online command output, not a guild
                // event, and must never be posted to a chat channel.
                return `unknown_event_type`;
        }
    }

    /**
     * Update formatter configuration
     * 
     * Dynamically updates the formatter's configuration by merging new options with
     * existing configuration. Clears the format cache to ensure new configuration
     * takes effect immediately for all subsequent formatting operations.
     * 
     * @param {object} newConfig - New configuration options to merge
     * @param {boolean} [newConfig.showTags] - Update tag display setting
     * @param {boolean} [newConfig.showSourceTag] - Update source tag prefix setting
     * @param {number} [newConfig.maxMessageLength] - Update max message length
     * @param {boolean} [newConfig.enableDebugLogging] - Update debug logging
     * 
     * @example
     * formatter.updateConfig({
     *   showTags: true,
     *   maxMessageLength: 300
     * });
     */
    updateConfig(newConfig) {
        this.config = { ...this.config, ...newConfig };
        this.formatCache.clear(); // Clear cache as configuration changed
        
        logger.debug('MessageFormatter configuration updated:', this.config);
    }

    /**
     * Get current configuration
     * 
     * Returns a copy of the current formatter configuration object. Useful for
     * inspecting current settings or creating derivative formatters with similar
     * configuration.
     * 
     * @returns {object} Current configuration (copy)
     * @returns {boolean} return.showTags - Display guild tags setting
     * @returns {boolean} return.showSourceTag - Show source tag prefix setting
     * @returns {boolean} return.enableDebugLogging - Debug logging enabled
     * @returns {number} return.maxMessageLength - Maximum message length
     * @returns {boolean} return.fallbackToBasic - Fallback formatting enabled
     * 
     * @example
     * const config = formatter.getConfig();
     * console.log(`Max length: ${config.maxMessageLength}`);
     * console.log(`Tags enabled: ${config.showTags}`);
     */
    getConfig() {
        return { ...this.config };
    }

    /**
     * Clear formatting cache
     * 
     * Clears the internal performance cache used for storing formatted messages.
     * Useful when templates are reloaded or configuration changes require fresh
     * formatting of all messages.
     * 
     * @example
     * // After reloading templates
     * templateLoader.reload();
     * formatter.clearCache();
     */
    clearCache() {
        this.formatCache.clear();
        logger.debug('MessageFormatter cache cleared');
    }
}

/**
 * Event types that intentionally have no template and must never be bridged
 *
 * The event parser classifies some server output as an "event" even though it is not a
 * guild happening. 'online' is the response body of the /g online command; posting it
 * to a chat channel would relay a member list every time the command runs. Types listed
 * here are skipped silently instead of warning about a missing template.
 *
 * @type {Array<string>}
 * @constant
 */
MessageFormatter.NON_BRIDGEABLE_EVENTS = ['online'];

module.exports = MessageFormatter;