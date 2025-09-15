const fs = require('fs');
const path = require('path');

class Config {
    constructor() {
        this.configPath = path.join(__dirname, '../../config/settings.json');
        this.settings = null;
        this.isLoaded = false;
        
        this.load();
    }

    load() {
        try {
            if (!fs.existsSync(this.configPath)) {
                throw new Error(`Configuration file not found: ${this.configPath}`);
            }

            const rawData = fs.readFileSync(this.configPath, 'utf8');
            this.settings = JSON.parse(rawData);

            this.isLoaded = true;
            console.log('✅ Configuration loaded successfully');
        
        } catch (error) {
            console.error('❌ Error loading configuration:', error.message);
            throw error;
        }
    }

    get(path, defaultValue = null) {
        if (!this.isLoaded) {
            throw new Error('Configuration not loaded');
        }

        const keys = path.split('.');
        let current = this.settings;

        for (const key of keys) {
            if (current === null || current === undefined || !(key in current)) {
                return defaultValue;
            }
            current = current[key];
        }

        return current;
    }

    // Guild Management

    getAllGuilds() {
        return this.get('guilds', []);
    }

    getEnabledGuilds() {
        return this.getAllGuilds().filter(guild => guild.enabled);
    }
}

module.exports = Config;