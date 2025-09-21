const fs = require('fs');
const path = require('path');
const logger = require('../shared/logger');

class TemplateLoader {
    constructor() {
        this.templatesPath = path.join(__dirname, '../../config/templates.json');
        this.templates = null;
        this.isLoaded = false;
        this.cache = new Map();
        
        this.load();
    }

    /**
     * Load templates from configuration file
     */
    load() {
        try {
            if (!fs.existsSync(this.templatesPath)) {
                throw new Error(`Templates configuration file not found: ${this.templatesPath}`);
            }

            const rawData = fs.readFileSync(this.templatesPath, 'utf8');
            this.templates = JSON.parse(rawData);

            this.isLoaded = true;
            this.validateTemplates();
            
            logger.info(`✅ Template configuration loaded successfully`);
            logger.debug(`Available platforms: ${Object.keys(this.templates.servers).join(', ')}`);
            
        } catch (error) {
            logger.logError(error, 'Failed to load template configuration');
            throw error;
        }
    }

    /**
     * Validate template configuration structure
     */
    validateTemplates() {
        if (!this.templates) {
            throw new Error('Templates not loaded');
        }

        if (!this.templates.servers || typeof this.templates.servers !== 'object') {
            throw new Error('Invalid templates configuration: missing servers section');
        }

        const platforms = Object.keys(this.templates.servers);
        logger.debug(`Validated templates for platforms: ${platforms.join(', ')}`);
    }

    /**
     * Get templates for a specific platform, server and category
     * @param {string} platform - Platform (messagesToMinecraft, messagesToDiscord)
     * @param {string} serverName - Server name (e.g., 'Hypixel')
     * @param {string} category - Template category (e.g., 'guild', 'officer', 'events')
     * @param {string} subCategory - Sub-category (e.g., 'basic', 'withTag', specific event)
     * @returns {object|string|null} Template object, string or null
     */
    getTemplate(platform, serverName, category, subCategory = null) {
        if (!this.isLoaded) {
            throw new Error('Templates not loaded');
        }

        const cacheKey = `${platform}-${serverName}-${category}-${subCategory || 'all'}`;
        if (this.cache.has(cacheKey)) {
            return this.cache.get(cacheKey);
        }

        let result = null;

        try {
            if (this.templates.servers[platform] && 
                this.templates.servers[platform][serverName] && 
                this.templates.servers[platform][serverName][category]) {
                
                const categoryTemplates = this.templates.servers[platform][serverName][category];
                
                if (subCategory && categoryTemplates[subCategory]) {
                    result = categoryTemplates[subCategory];
                } else if (!subCategory) {
                    result = categoryTemplates;
                }
            }

            // Cache the result
            this.cache.set(cacheKey, result);
            
        } catch (error) {
            logger.logError(error, `Error getting template: ${platform}/${serverName}/${category}/${subCategory}`);
            result = null;
        }

        return result;
    }

    /**
     * Get the best template based on configuration and availability
     * @param {string} platform - Platform (messagesToMinecraft, messagesToDiscord)
     * @param {string} serverName - Server name
     * @param {string} category - Template category
     * @param {object} config - Configuration object with tag settings
     * @returns {string|null} Best matching template string
     */
    getBestTemplate(platform, serverName, category, config = {}) {
        const templates = this.getTemplate(platform, serverName, category);
        if (!templates || typeof templates !== 'object') {
            return templates; // Return as-is if it's a string or null
        }

        // Determine template priority based on configuration
        const hasTagEnabled = config.showTags === true;
        const hasSourceTag = config.showSourceTag === true;
        
        let templateKey = 'basic';
        
        if (hasTagEnabled && hasSourceTag && templates.withBothTags) {
            templateKey = 'withBothTags';
        } else if (hasSourceTag && templates.withSourceTag) {
            templateKey = 'withSourceTag';
        } else if (hasTagEnabled && templates.withTag) {
            templateKey = 'withTag';
        } else if (templates.basic) {
            templateKey = 'basic';
        } else {
            // Get first available template
            const availableKeys = Object.keys(templates);
            if (availableKeys.length > 0) {
                templateKey = availableKeys[0];
            }
        }

        const selectedTemplate = templates[templateKey];
        
        if (config.enableDebugLogging) {
            logger.debug(`Selected template '${templateKey}' for ${platform}/${serverName}/${category}:`, selectedTemplate);
        }

        return selectedTemplate || null;
    }

    /**
     * Get event template specifically
     * @param {string} platform - Platform (messagesToMinecraft, messagesToDiscord)
     * @param {string} serverName - Server name
     * @param {string} eventType - Event type (join, leave, kick, etc.)
     * @param {object} config - Configuration object
     * @returns {string|null} Event template string
     */
    getEventTemplate(platform, serverName, eventType, config = {}) {
        const eventTemplates = this.getTemplate(platform, serverName, 'events', eventType);
        
        if (!eventTemplates || typeof eventTemplates !== 'object') {
            return eventTemplates;
        }

        return this.getBestTemplate(platform, serverName, `events.${eventType}`, config) ||
               this.getBestTemplateFromObject(eventTemplates, config);
    }

    /**
     * Get best template from a template object
     * @param {object} templates - Template object
     * @param {object} config - Configuration object
     * @returns {string|null} Best template string
     */
    getBestTemplateFromObject(templates, config = {}) {
        if (!templates || typeof templates !== 'object') {
            return templates;
        }

        const hasTagEnabled = config.showTags === true;
        const hasSourceTag = config.showSourceTag === true;
        
        if (hasTagEnabled && hasSourceTag && templates.withBothTags) {
            return templates.withBothTags;
        } else if (hasSourceTag && templates.withSourceTag) {
            return templates.withSourceTag;
        } else if (hasTagEnabled && templates.withTag) {
            return templates.withTag;
        } else if (templates.basic) {
            return templates.basic;
        }

        // Return first available template
        const keys = Object.keys(templates);
        return keys.length > 0 ? templates[keys[0]] : null;
    }

    /**
     * Get supported servers for a platform
     * @param {string} platform - Platform name
     * @returns {Array} Array of supported server names
     */
    getSupportedServers(platform) {
        if (!this.isLoaded || !this.templates.servers[platform]) {
            return [];
        }

        return Object.keys(this.templates.servers[platform]);
    }

    /**
     * Get supported platforms
     * @returns {Array} Array of supported platform names
     */
    getSupportedPlatforms() {
        if (!this.isLoaded) {
            return [];
        }

        return Object.keys(this.templates.servers);
    }

    /**
     * Check if a platform/server combination is supported
     * @param {string} platform - Platform name
     * @param {string} serverName - Server name
     * @returns {boolean} Whether combination is supported
     */
    isSupported(platform, serverName) {
        return this.getSupportedServers(platform).includes(serverName);
    }

    /**
     * Get default values
     * @param {string} category - Default category (placeholders, colors, emojis)
     * @returns {object} Default values for the category
     */
    getDefaults(category) {
        if (!this.templates.defaults || !this.templates.defaults[category]) {
            return {};
        }

        return this.templates.defaults[category];
    }

    /**
     * Get template metadata
     * @returns {object} Template metadata
     */
    getMetadata() {
        return this.templates.metadata || {};
    }

    /**
     * Add custom template at runtime
     * @param {string} platform - Platform name
     * @param {string} serverName - Server name
     * @param {string} category - Template category
     * @param {string} subCategory - Sub-category
     * @param {string} template - Template string
     */
    addCustomTemplate(platform, serverName, category, subCategory, template) {
        if (!this.templates.servers[platform]) {
            this.templates.servers[platform] = {};
        }

        if (!this.templates.servers[platform][serverName]) {
            this.templates.servers[platform][serverName] = {};
        }

        if (!this.templates.servers[platform][serverName][category]) {
            this.templates.servers[platform][serverName][category] = {};
        }

        this.templates.servers[platform][serverName][category][subCategory] = template;

        // Clear cache for this template
        const cacheKey = `${platform}-${serverName}-${category}-${subCategory}`;
        this.cache.delete(cacheKey);

        logger.debug(`Added custom template: ${platform}/${serverName}/${category}/${subCategory}`);
    }

    /**
     * Clear template cache
     */
    clearCache() {
        this.cache.clear();
        logger.debug('Template cache cleared');
    }
}

// Singleton instance
let templateLoaderInstance = null;

/**
 * Get singleton instance of TemplateLoader
 * @returns {TemplateLoader} TemplateLoader instance
 */
function getTemplateLoader() {
    if (!templateLoaderInstance) {
        templateLoaderInstance = new TemplateLoader();
    }
    return templateLoaderInstance;
}

module.exports = {
    TemplateLoader,
    getTemplateLoader
};