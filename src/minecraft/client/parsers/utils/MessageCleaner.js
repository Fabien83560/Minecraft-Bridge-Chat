// Specific Imports
const logger = require("../../../../shared/logger")

class MessageCleaner {
    constructor(config) {
        this.config = config;

        this.colorCodePatterns = {};
        this.cleaningPatterns = {};
        this.characterMappings = {};

        this.initializeCleaner();
    }

    async initializeCleaner() {
        // Minecraft color code patterns
        this.colorCodePatterns = {
            // Standard color codes (§0-9, §a-f)
            colorCodes: /§[0-9a-f]/g,
            
            // Formatting codes (§k, §l, §m, §n, §o, §r)
            formattingCodes: /§[klmnor]/g,
            
            // All codes combined
            allCodes: /§[0-9a-fklmnor]/g,
            
            // Alternative color code format (&)
            ampersandCodes: /&[0-9a-fklmnor]/g
        };

        // Text cleaning patterns
        this.cleaningPatterns = {
            // Multiple whitespace
            multipleSpaces: /\s+/g,
            
            // Leading/trailing whitespace
            trimWhitespace: /^\s+|\s+$/g,
            
            // Control characters (except newlines and tabs)
            controlChars: /[\x00-\x08\x0B-\x0C\x0E-\x1F\x7F]/g,
            
            // URLs
            urls: /https?:\/\/[^\s]+/gi,
            
            // Discord invites
            discordInvites: /discord\.gg\/[^\s]+/gi,
            
            // IP addresses
            ipAddresses: /\b(?:\d{1,3}\.){3}\d{1,3}(?::\d+)?\b/g
        };

        // Special character mappings for normalization
        this.characterMappings = {
            // Smart quotes
            '“': '"', // opening double quote
            '”': '"', // closing double quote
            '‘': "'", // opening single quote
            '’': "'", // closing single quote

            // Dashes
            '–': '-', // en-dash
            '—': '-', // em-dash

            // Spaces
            '\u00A0': ' ', // Non-breaking space
            '　': ' ',     // Full-width space
        };
    }

    /**
     * Clean a raw Minecraft message
     * @param {string|object} rawMessage - Raw message from Minecraft client
     * @returns {string} Cleaned message text
     */
    cleanMessage(rawMessage) {
        try {
            // Convert message to string
            let messageText = this.extractMessageText(rawMessage);
            
            // Apply cleaning steps in order
            messageText = this.removeMinecraftColorCodes(messageText);
            messageText = this.removeControlCharacters(messageText);
            messageText = this.normalizeCharacters(messageText);    

            if (this.config.stripUrls) {
                messageText = this.removeUrls(messageText);
            }
            
            if (this.config.normalizeWhitespace) {
                messageText = this.normalizeWhitespace(messageText);
            }
            
            messageText = this.truncateMessage(messageText);
            
            const result = messageText.trim();
            
            return result;
            
        } catch (error) {
            logger.logError(error, 'Error cleaning message');
            // Return a safe fallback
            return String(rawMessage).substring(0, 100);
        }
    }

    /**
     * Clean message content only (for already parsed messages)
     * @param {string} messageContent - Message content to clean
     * @returns {string} Cleaned message content
     */
    cleanMessageContent(messageContent) {
        if (!messageContent || typeof messageContent !== 'string') {
            return '';
        }

        let cleaned = messageContent;
        
        // Remove color codes if enabled
        if (this.config.removeColorCodes) {
            cleaned = this.removeMinecraftColorCodes(cleaned);
        }
        
        // Remove formatting if enabled
        if (this.config.removeFormatting) {
            cleaned = this.removeFormatting(cleaned);
        }
        
        // Normalize characters
        cleaned = this.normalizeCharacters(cleaned);
        
        // Strip URLs if enabled
        if (this.config.stripUrls) {
            cleaned = this.removeUrls(cleaned);
        }
        
        // Normalize whitespace
        if (this.config.normalizeWhitespace) {
            cleaned = this.normalizeWhitespace(cleaned);
        }
        
        return cleaned.trim();
    }

    /**
     * Extract text from various message formats
     * @param {string|object} rawMessage - Raw message
     * @returns {string} Extracted text
     */
    extractMessageText(rawMessage) {
        // If already a string, return as-is
        if (typeof rawMessage === 'string') {
            return rawMessage;
        }
        
        // Handle JSON message objects from Minecraft client
        if (rawMessage && typeof rawMessage === 'object') {
            try {
                // FIRST: Try toString() method - this often works for Minecraft message objects
                const stringified = rawMessage.toString();
                
                if (stringified && stringified !== '[object Object]' && stringified.length > 4) {
                    return stringified;
                }
                
                // Try to extract from 'text' property
                if (rawMessage.text) {
                    return rawMessage.text;
                }
                
                // Try to extract from 'extra' array (complex messages)
                if (rawMessage.extra && Array.isArray(rawMessage.extra)) {
                    let fullText = rawMessage.text || '';
                    
                    for (const part of rawMessage.extra) {
                        if (part.text) {
                            fullText += part.text;
                        }
                    }
                    
                    if (fullText.length > 0) {
                        return fullText;
                    }
                }
                
                // Try other common message properties
                if (rawMessage.message) {
                    return rawMessage.message;
                }
                
                if (rawMessage.content) {
                    return rawMessage.content;
                }
                
                // Try JSON.stringify as fallback - but clean it up
                const jsonString = JSON.stringify(rawMessage);
                
                if (jsonString && jsonString !== '{}') {
                    // Try to extract readable text from JSON
                    const textMatch = jsonString.match(/"text":"([^"]+)"/);
                    if (textMatch) {
                        return textMatch[1];
                    }
                    return jsonString;
                }
            } catch (error) {
                logger.debug('Error extracting text from message object:', error.message);
            }
        }
        
        // Final fallback - convert to string
        const fallback = String(rawMessage || '');
        return fallback;
    }

    /**
     * Remove Minecraft color codes from text
     * @param {string} text - Text with color codes
     * @returns {string} Text without color codes
     */
    removeMinecraftColorCodes(text) {
        if (!text || typeof text !== 'string') {
            return text;
        }

        // Remove standard Minecraft color codes (§)
        text = text.replace(this.colorCodePatterns.allCodes, '');
        
        // Remove alternative color codes (&) if present
        text = text.replace(this.colorCodePatterns.ampersandCodes, '');
        
        return text;
    }

    /**
     * Remove formatting codes specifically
     * @param {string} text - Text with formatting codes
     * @returns {string} Text without formatting codes
     */
    removeFormatting(text) {
        if (!text || typeof text !== 'string') {
            return text;
        }

        return text.replace(this.colorCodePatterns.formattingCodes, '');
    }

    /**
     * Remove control characters from text
     * @param {string} text - Text with control characters
     * @returns {string} Text without control characters
     */
    removeControlCharacters(text) {
        if (!text || typeof text !== 'string') {
            return text;
        }

        return text.replace(this.cleaningPatterns.controlChars, '');
    }

    /**
     * Normalize special characters
     * @param {string} text - Text to normalize
     * @returns {string} Normalized text
     */
    normalizeCharacters(text) {
        if (!text || typeof text !== 'string') {
            return text;
        }

        let normalized = text;
        
        // Apply character mappings
        for (const [from, to] of Object.entries(this.characterMappings)) {
            normalized = normalized.replace(new RegExp(from, 'g'), to);
        }
        
        return normalized;
    }

    /**
     * Remove URLs from text
     * @param {string} text - Text with URLs
     * @returns {string} Text without URLs
     */
    removeUrls(text) {
        if (!text || typeof text !== 'string') {
            return text;
        }

        // Remove HTTP/HTTPS URLs
        text = text.replace(this.cleaningPatterns.urls, '[URL]');
        
        // Remove Discord invites
        text = text.replace(this.cleaningPatterns.discordInvites, '[DISCORD]');
        
        // Remove IP addresses if configured
        text = text.replace(this.cleaningPatterns.ipAddresses, '[IP]');
        
        return text;
    }

    /**
     * Normalize whitespace in text
     * @param {string} text - Text to normalize
     * @returns {string} Text with normalized whitespace
     */
    normalizeWhitespace(text) {
        if (!text || typeof text !== 'string') {
            return text;
        }

        // Replace multiple spaces with single space
        text = text.replace(this.cleaningPatterns.multipleSpaces, ' ');
        
        // Remove leading and trailing whitespace
        text = text.replace(this.cleaningPatterns.trimWhitespace, '');
        
        return text;
    }

    /**
     * Truncate message to maximum length
     * @param {string} text - Text to truncate
     * @returns {string} Truncated text
     */
    truncateMessage(text) {
        if (!text || typeof text !== 'string') {
            return text;
        }

        if (text.length <= this.config.maxLength) {
            return text;
        }

        // Truncate and add ellipsis
        const truncated = text.substring(0, this.config.maxLength - 3);
        
        // Try to break at word boundary
        const lastSpace = truncated.lastIndexOf(' ');
        if (lastSpace > this.config.maxLength * 0.8) {
            return truncated.substring(0, lastSpace) + '...';
        }
        
        return truncated + '...';
    }

    /**
     * Check if text contains color codes
     * @param {string} text - Text to check
     * @returns {boolean} Whether text has color codes
     */
    hasColorCodes(text) {
        if (!text || typeof text !== 'string') {
            return false;
        }

        return this.colorCodePatterns.allCodes.test(text) || 
               this.colorCodePatterns.ampersandCodes.test(text);
    }

    /**
     * Extract color codes from text
     * @param {string} text - Text to extract codes from
     * @returns {Array} Array of found color codes
     */
    extractColorCodes(text) {
        if (!text || typeof text !== 'string') {
            return [];
        }

        const codes = [];
        
        // Find standard color codes
        let match;
        const regex = /§[0-9a-fklmnor]/g;
        while ((match = regex.exec(text)) !== null) {
            codes.push(match[0]);
        }
        
        return codes;
    }

    /**
     * Get text length without color codes
     * @param {string} text - Text to measure
     * @returns {number} Length without color codes
     */
    getCleanLength(text) {
        if (!text || typeof text !== 'string') {
            return 0;
        }

        const cleaned = this.removeMinecraftColorCodes(text);
        return cleaned.length;
    }

    /**
     * Clean text for Discord compatibility
     * @param {string} text - Text to clean for Discord
     * @returns {string} Discord-compatible text
     */
    cleanForDiscord(text) {
        if (!text || typeof text !== 'string') {
            return text;
        }

        let cleaned = text;
        
        // Remove Minecraft color codes
        cleaned = this.removeMinecraftColorCodes(cleaned);
        
        // Escape Discord markdown if needed
        if (this.config.escapeDiscordMarkdown) {
            cleaned = this.escapeDiscordMarkdown(cleaned);
        }
        
        // Normalize whitespace
        cleaned = this.normalizeWhitespace(cleaned);
        
        // Discord has a 2000 character limit
        const discordLimit = Math.min(this.config.maxLength, 2000);
        if (cleaned.length > discordLimit) {
            cleaned = cleaned.substring(0, discordLimit - 3) + '...';
        }
        
        return cleaned;
    }

    /**
     * Clean text for Minecraft compatibility
     * @param {string} text - Text to clean for Minecraft
     * @returns {string} Minecraft-compatible text
     */
    cleanForMinecraft(text) {
        if (!text || typeof text !== 'string') {
            return text;
        }

        let cleaned = text;
        
        // Remove Discord markdown
        cleaned = this.removeDiscordMarkdown(cleaned);
        
        // Normalize whitespace
        cleaned = this.normalizeWhitespace(cleaned);
        
        // Minecraft typically has a 256 character limit
        const minecraftLimit = Math.min(this.config.maxLength, 256);
        if (cleaned.length > minecraftLimit) {
            cleaned = cleaned.substring(0, minecraftLimit - 3) + '...';
        }
        
        return cleaned;
    }

    /**
     * Escape Discord markdown characters
     * @param {string} text - Text to escape
     * @returns {string} Escaped text
     */
    escapeDiscordMarkdown(text) {
        if (!text || typeof text !== 'string') {
            return text;
        }

        // Escape Discord markdown characters
        return text.replace(/([*_`~|\\])/g, '\\$1');
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

        // Remove Discord markdown patterns
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
     * Update configuration
     * @param {object} newConfig - New configuration options
     */
    updateConfig(newConfig) {
        this.config = { ...this.config, ...newConfig };
        logger.debug('MessageCleaner configuration updated');
    }

    /**
     * Get current configuration
     * @returns {object} Current configuration
     */
    getConfig() {
        return { ...this.config };
    }

    /**
     * Test message cleaning (for debugging)
     * @param {string} text - Text to test
     * @returns {object} Test results showing each cleaning step
     */
    testCleaning(text) {
        const steps = {
            original: text,
            extracted: this.extractMessageText(text),
            colorCodesRemoved: null,
            controlCharsRemoved: null,
            charactersNormalized: null,
            urlsRemoved: null,
            whitespaceNormalized: null,
            truncated: null,
            final: null
        };

        let current = steps.extracted;
        
        current = this.removeMinecraftColorCodes(current);
        steps.colorCodesRemoved = current;
        
        current = this.removeControlCharacters(current);
        steps.controlCharsRemoved = current;
        
        current = this.normalizeCharacters(current);
        steps.charactersNormalized = current;
        
        if (this.config.stripUrls) {
            current = this.removeUrls(current);
            steps.urlsRemoved = current;
        }
        
        if (this.config.normalizeWhitespace) {
            current = this.normalizeWhitespace(current);
            steps.whitespaceNormalized = current;
        }
        
        current = this.truncateMessage(current);
        steps.truncated = current;
        
        steps.final = current.trim();
        
        return {
            steps: steps,
            hasColorCodes: this.hasColorCodes(text),
            cleanLength: this.getCleanLength(text),
            finalLength: steps.final.length,
            changesMade: steps.original !== steps.final
        };
    }
}

module.exports = MessageCleaner;