const fs = require('fs');
const path = require('path');
const logger = require('../shared/logger');

class PatternLoader {
    constructor() {
        this.patternsPath = path.join(__dirname, '../../config/patterns.json');
        this.patterns = null;
        this.isLoaded = false;
        this.cache = new Map();
        
        this.load();
    }

    /**
     * Load patterns from configuration file
     */
    load() {
        try {
            if (!fs.existsSync(this.patternsPath)) {
                throw new Error(`Patterns configuration file not found: ${this.patternsPath}`);
            }

            const rawData = fs.readFileSync(this.patternsPath, 'utf8');
            this.patterns = JSON.parse(rawData);

            this.isLoaded = true;
            this.validatePatterns();
            
            logger.info(`✅ Pattern configuration loaded successfully`);
            logger.debug(`Supported servers: ${Object.keys(this.patterns.servers).join(', ')}`);
            
        } catch (error) {
            logger.logError(error, 'Failed to load pattern configuration');
            throw error;
        }
    }

    /**
     * Validate pattern configuration structure
     */
    validatePatterns() {
        if (!this.patterns) {
            throw new Error('Patterns not loaded');
        }

        if (!this.patterns.servers || typeof this.patterns.servers !== 'object') {
            throw new Error('Invalid patterns configuration: missing servers section');
        }

        const serverCount = Object.keys(this.patterns.servers).length;
        logger.debug(`Validated ${serverCount} server configurations`);
    }

    /**
     * Get patterns for a specific server and category
     * @param {string} serverName - Server name (e.g., 'Hypixel', 'Vanilla')
     * @param {string} category - Pattern category (e.g., 'events', 'messages', 'system', 'ignore')
     * @param {string} subCategory - Sub-category (e.g., 'join', 'guild', etc.)
     * @returns {Array} Array of pattern objects
     */
    getPatterns(serverName, category, subCategory = null) {
        if (!this.isLoaded) {
            throw new Error('Patterns not loaded');
        }

        const cacheKey = `${serverName}-${category}-${subCategory || 'all'}`;
        if (this.cache.has(cacheKey)) {
            return this.cache.get(cacheKey);
        }

        let result = [];

        // Get server-specific patterns
        if (this.patterns.servers[serverName]) {
            const serverPatterns = this.patterns.servers[serverName];
            
            if (serverPatterns[category]) {
                if (subCategory && serverPatterns[category][subCategory]) {
                    result = [...serverPatterns[category][subCategory]];
                } else if (!subCategory) {
                    result = serverPatterns[category];
                }
            }
        }

        // Fallback to defaults if no server-specific patterns found and server is not recognized
        if (result.length === 0 && !this.patterns.servers[serverName]) {
            logger.warn(`Unknown server '${serverName}', falling back to vanilla patterns`);
            
            if (this.patterns.servers.Vanilla && this.patterns.servers.Vanilla[category]) {
                if (subCategory && this.patterns.servers.Vanilla[category][subCategory]) {
                    result = [...this.patterns.servers.Vanilla[category][subCategory]];
                } else if (!subCategory) {
                    result = this.patterns.servers.Vanilla[category];
                }
            }
        }

        // Convert pattern objects to RegExp objects
        if (Array.isArray(result)) {
            result = result.map(patternObj => this.createPatternObject(patternObj));
        }

        // Cache the result
        this.cache.set(cacheKey, result);
        
        logger.debug(`Loaded ${result.length} patterns for ${serverName}/${category}${subCategory ? '/' + subCategory : ''}`);
        return result;
    }

    /**
     * Create a pattern object with compiled RegExp
     * @param {object} patternObj - Pattern object from configuration
     * @returns {object} Pattern object with compiled regex
     */
    createPatternObject(patternObj) {
        if (!patternObj.pattern) {
            logger.warn('Pattern object missing pattern property:', patternObj);
            return null;
        }

        try {
            let flags = patternObj.flags || '';
            if (flags === 'none') {
                flags = ''; // Fix "none" to an empty string
            }
            
            const regex = new RegExp(patternObj.pattern, flags);
            
            return {
                pattern: regex,
                originalPattern: patternObj.pattern,
                groups: patternObj.groups || [],
                flags: flags,
                description: patternObj.description || 'No description',
                direction: patternObj.direction || null,
                custom: false
            };
        } catch (error) {
            logger.logError(error, `Failed to compile pattern: ${patternObj.pattern}`);
            return null;
        }
    }

    /**
     * Get detection patterns for quick message classification
     * @param {string} serverName - Server name
     * @param {string} type - Detection type ('guildChat', 'officerChat', 'guildEvent', 'guildSystem')
     * @returns {Array} Array of detection pattern objects
     */
    getDetectionPatterns(serverName, type) {
        if (!this.isLoaded) {
            throw new Error('Patterns not loaded');
        }

        const cacheKey = `detection-${serverName}-${type}`;
        if (this.cache.has(cacheKey)) {
            return this.cache.get(cacheKey);
        }

        let result = [];

        if (this.patterns.servers[serverName] && this.patterns.servers[serverName].detection) {
            const detectionPatterns = this.patterns.servers[serverName].detection[type];
            if (detectionPatterns && Array.isArray(detectionPatterns)) {
                result = detectionPatterns.map(patternObj => this.createPatternObject(patternObj)).filter(p => p !== null);
            }
        }

        this.cache.set(cacheKey, result);
        return result;
    }
    /**
     * Get commands response patterns for a specific server
     * @param {string} serverName - Server name (e.g., 'Hypixel')
     * @returns {object|null} Commands response patterns or null if not found
     */
    getCommandsResponsePatterns(serverName) {
        if (!this.isLoaded) {
            throw new Error('Patterns not loaded');
        }

        const cacheKey = `commandsResponse-${serverName}`;
        if (this.cache.has(cacheKey)) {
            return this.cache.get(cacheKey);
        }

        let result = null;

        try {
            const serverData = this.patterns?.servers?.[serverName];
            if (!serverData) {
                logger.warn(`No server data found for: ${serverName}`);
                this.cache.set(cacheKey, null);
                return null;
            }

            const commandsResponse = serverData.detection?.commandsResponse;
            if (!commandsResponse) {
                logger.debug(`No commands response patterns found for server: ${serverName}`);
                this.cache.set(cacheKey, null);
                return null;
            }

            result = commandsResponse;
            this.cache.set(cacheKey, result);
            
            const commandTypes = Object.keys(commandsResponse);
            logger.debug(`Loaded commands response patterns for ${serverName}: ${commandTypes.join(', ')}`);
            
            return result;

        } catch (error) {
            logger.logError(error, `Failed to get commands response patterns for ${serverName}`);
            this.cache.set(cacheKey, null);
            return null;
        }
    }

    /**
     * Get all event types supported by a server
     * @param {string} serverName - Server name
     * @returns {Array} Array of event type names
     */
    getEventTypes(serverName) {
        if (!this.patterns.servers[serverName] || !this.patterns.servers[serverName].events) {
            return [];
        }

        return Object.keys(this.patterns.servers[serverName].events);
    }

    /**
     * Get all message types supported by a server
     * @param {string} serverName - Server name
     * @returns {Array} Array of message type names
     */
    getMessageTypes(serverName) {
        if (!this.patterns.servers[serverName] || !this.patterns.servers[serverName].messages) {
            return [];
        }

        return Object.keys(this.patterns.servers[serverName].messages);
    }

    /**
     * Add custom pattern at runtime
     * @param {string} serverName - Server name
     * @param {string} category - Pattern category
     * @param {string} subCategory - Sub-category
     * @param {object} patternObj - Pattern object to add
     */
    addCustomPattern(serverName, category, subCategory, patternObj) {
        if (!this.patterns.servers[serverName]) {
            this.patterns.servers[serverName] = {};
        }

        if (!this.patterns.servers[serverName][category]) {
            this.patterns.servers[serverName][category] = {};
        }

        if (!this.patterns.servers[serverName][category][subCategory]) {
            this.patterns.servers[serverName][category][subCategory] = [];
        }

        // Mark as custom pattern
        patternObj.custom = true;
        this.patterns.servers[serverName][category][subCategory].push(patternObj);

        // Clear cache for this pattern set
        const cacheKey = `${serverName}-${category}-${subCategory}`;
        this.cache.delete(cacheKey);

        logger.debug(`Added custom pattern for ${serverName}/${category}/${subCategory}: ${patternObj.pattern}`);
    }

    /**
     * Get supported servers list
     * @returns {Array} Array of supported server names
     */
    getSupportedServers() {
        if (!this.isLoaded) {
            return [];
        }

        return Object.keys(this.patterns.servers);
    }

    /**
     * Check if server is supported
     * @param {string} serverName - Server name to check
     * @returns {boolean} Whether server is supported
     */
    isServerSupported(serverName) {
        return this.getSupportedServers().includes(serverName);
    }

    /**
     * Get default values (color codes, ranks, etc.)
     * @param {string} category - Default category to get
     * @returns {object} Default values for the category
     */
    getDefaults(category) {
        if (!this.patterns.defaults || !this.patterns.defaults[category]) {
            return {};
        }

        return this.patterns.defaults[category];
    }

    /**
     * Get pattern metadata
     * @returns {object} Pattern metadata
     */
    getMetadata() {
        return this.patterns.metadata || {};
    }

    /**
     * Clear pattern cache
     */
    clearCache() {
        this.cache.clear();
        logger.debug('Pattern cache cleared');
    }
}

// Singleton instance
let patternLoaderInstance = null;

/**
 * Get singleton instance of PatternLoader
 * @returns {PatternLoader} PatternLoader instance
 */
function getPatternLoader() {
    if (!patternLoaderInstance) {
        patternLoaderInstance = new PatternLoader();
    }
    return patternLoaderInstance;
}

module.exports = {
    PatternLoader,
    getPatternLoader
};