const fs = require('fs');
const path = require('path');
const logger = require('../src/shared/logger');

class PatternLoader {
    constructor() {
        this.patternsPath = path.join(__dirname, './patterns.json');
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
     * Reload patterns from file
     */
    reload() {
        logger.info('Reloading pattern configuration...');
        this.cache.clear();
        this.isLoaded = false;
        this.patterns = null;
        
        this.load();
    }

    /**
     * Get pattern statistics
     * @returns {object} Statistics about loaded patterns
     */
    getStatistics() {
        if (!this.isLoaded) {
            return { loaded: false };
        }

        const stats = {
            loaded: true,
            servers: Object.keys(this.patterns.servers).length,
            cacheSize: this.cache.size,
            patterns: {}
        };

        for (const [serverName, serverConfig] of Object.entries(this.patterns.servers)) {
            stats.patterns[serverName] = {
                events: 0,
                messages: 0,
                system: 0,
                ignore: 0,
                detection: 0
            };

            if (serverConfig.events) {
                stats.patterns[serverName].events = Object.values(serverConfig.events)
                    .reduce((total, patterns) => total + (Array.isArray(patterns) ? patterns.length : 0), 0);
            }

            if (serverConfig.messages) {
                stats.patterns[serverName].messages = Object.values(serverConfig.messages)
                    .reduce((total, patterns) => total + (Array.isArray(patterns) ? patterns.length : 0), 0);
            }

            if (serverConfig.system && Array.isArray(serverConfig.system)) {
                stats.patterns[serverName].system = serverConfig.system.length;
            }

            if (serverConfig.ignore && Array.isArray(serverConfig.ignore)) {
                stats.patterns[serverName].ignore = serverConfig.ignore.length;
            }

            if (serverConfig.detection) {
                stats.patterns[serverName].detection = Object.values(serverConfig.detection)
                    .reduce((total, patterns) => total + (Array.isArray(patterns) ? patterns.length : 0), 0);
            }
        }

        return stats;
    }

    /**
     * Clear pattern cache
     */
    clearCache() {
        this.cache.clear();
        logger.debug('Pattern cache cleared');
    }

    /**
     * Test pattern matching for debugging
     * @param {string} serverName - Server name
     * @param {string} category - Pattern category
     * @param {string} subCategory - Sub-category
     * @param {string} testMessage - Message to test
     * @returns {object} Test results
     */
    testPatterns(serverName, category, subCategory, testMessage) {
        const patterns = this.getPatterns(serverName, category, subCategory);
        const results = {
            server: serverName,
            category: category,
            subCategory: subCategory,
            testMessage: testMessage,
            matches: [],
            patternsTested: patterns.length
        };

        for (let i = 0; i < patterns.length; i++) {
            const patternObj = patterns[i];
            if (!patternObj || !patternObj.pattern) continue;

            const match = testMessage.match(patternObj.pattern);
            if (match) {
                results.matches.push({
                    patternIndex: i,
                    pattern: patternObj.originalPattern,
                    description: patternObj.description,
                    groups: patternObj.groups,
                    matchedGroups: match.slice(1),
                    fullMatch: match[0]
                });
            }
        }

        return results;
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