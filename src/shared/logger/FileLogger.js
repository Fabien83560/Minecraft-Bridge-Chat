const fs = require('fs');
const path = require('path');

class FileLogger {
	constructor() {
		this.logDir = path.join(__dirname, '../../../data/logs');
		this.maxFileSize = 10 * 1024 * 1024; // 10MB
		this.maxFiles = 5;
		
		this.ensureLogDirectory();
		this.currentLogFile = this.getLogFileName();
		this.currentErrorLogFile = this.getErrorLogFileName();
	}
	
	ensureLogDirectory() {
		if (!fs.existsSync(this.logDir)) {
			fs.mkdirSync(this.logDir, { recursive: true });
		}
	}
	
	getLogFileName() {
		const date = new Date();
		const dateString = date.toISOString().split('T')[0]; // YYYY-MM-DD
		return path.join(this.logDir, `bridge-${dateString}.log`);
	}
	
	getErrorLogFileName() {
		const date = new Date();
		const dateString = date.toISOString().split('T')[0]; // YYYY-MM-DD
		return path.join(this.logDir, `bridge-${dateString}-errors.log`);
	}
	
	write(level, message) {
		try {
			// Check if we need a new file (new day)
			const currentFileName = this.getLogFileName();
			const currentErrorFileName = this.getErrorLogFileName();
			
			if (currentFileName !== this.currentLogFile) {
				this.currentLogFile = currentFileName;
			}
			
			if (currentErrorFileName !== this.currentErrorLogFile) {
				this.currentErrorLogFile = currentErrorFileName;
			}
			
			// Check file size and rotate if needed
			this.rotateIfNeeded();
			
			// Write message to main log file
			const logEntry = `${message}\n`;
			fs.appendFileSync(this.currentLogFile, logEntry, 'utf8');
			
			// If it's an error, also write to error log file
			if (level === 'error') {
				fs.appendFileSync(this.currentErrorLogFile, logEntry, 'utf8');
			}
			
		} catch (error) {
			// In case of write error, log to console only
			console.error('Failed to write to log file:', error.message);
		}
	}
	
	rotateIfNeeded() {
		try {
			// Check and rotate main log file
			if (fs.existsSync(this.currentLogFile)) {
				const stats = fs.statSync(this.currentLogFile);
				if (stats.size > this.maxFileSize) {
					this.rotateLogFile(this.currentLogFile, false);
				}
			}
			
			// Check and rotate error log file
			if (fs.existsSync(this.currentErrorLogFile)) {
				const errorStats = fs.statSync(this.currentErrorLogFile);
				if (errorStats.size > this.maxFileSize) {
					this.rotateLogFile(this.currentErrorLogFile, true);
				}
			}
		} catch (error) {
			console.error('Error checking log file size:', error.message);
		}
	}
	
	rotateLogFile(filePath, isErrorFile = false) {
		try {
			const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
			const rotatedFileName = filePath.replace('.log', `-${timestamp}.log`);
			
			// Rename current file
			fs.renameSync(filePath, rotatedFileName);
			
			// Clean old files (both regular and error files)
			this.cleanOldLogFiles();
			
		} catch (error) {
			console.error('Error rotating log file:', error.message);
		}
	}
	
	cleanOldLogFiles() {
		try {
			// Clean regular log files
			this.cleanOldLogFilesByPattern('bridge-', '.log');
			
			// Clean error log files
			this.cleanOldLogFilesByPattern('bridge-', '-errors.log');
			
		} catch (error) {
			console.error('Error cleaning old log files:', error.message);
		}
	}
	
	cleanOldLogFilesByPattern(prefix, suffix) {
		try {
			const files = fs.readdirSync(this.logDir)
				.filter(file => file.startsWith(prefix) && file.endsWith(suffix))
				.map(file => ({
					name: file,
					path: path.join(this.logDir, file),
					mtime: fs.statSync(path.join(this.logDir, file)).mtime
				}))
				.sort((a, b) => b.mtime - a.mtime);
			
			// Delete excess files
			if (files.length > this.maxFiles) {
				const filesToDelete = files.slice(this.maxFiles);
				filesToDelete.forEach(file => {
					try {
						fs.unlinkSync(file.path);
					} catch (deleteError) {
						console.error('Error deleting old log file:', deleteError.message);
					}
				});
			}
		} catch (error) {
			console.error(`Error cleaning old log files with pattern ${prefix}*${suffix}:`, error.message);
		}
	}
	
	// Method to get recent logs from main log file
	getRecentLogs(lines = 100) {
		try {
			if (!fs.existsSync(this.currentLogFile)) {
				return [];
			}
			
			const content = fs.readFileSync(this.currentLogFile, 'utf8');
			const allLines = content.split('\n').filter(line => line.trim());
			
			return allLines.slice(-lines);
		} catch (error) {
			console.error('Error reading log file:', error.message);
			return [];
		}
	}
	
	// Method to get recent error logs from error log file
	getRecentErrorLogs(lines = 100) {
		try {
			if (!fs.existsSync(this.currentErrorLogFile)) {
				return [];
			}
			
			const content = fs.readFileSync(this.currentErrorLogFile, 'utf8');
			const allLines = content.split('\n').filter(line => line.trim());
			
			return allLines.slice(-lines);
		} catch (error) {
			console.error('Error reading error log file:', error.message);
			return [];
		}
	}
	
	// Method to get current log file paths (useful for monitoring)
	getCurrentLogFiles() {
		return {
			main: this.currentLogFile,
			errors: this.currentErrorLogFile
		};
	}
	
	// Method to get log statistics
	getLogStats() {
		const stats = {
			main: { exists: false, size: 0 },
			errors: { exists: false, size: 0 }
		};
		
		try {
			if (fs.existsSync(this.currentLogFile)) {
				stats.main.exists = true;
				stats.main.size = fs.statSync(this.currentLogFile).size;
			}
			
			if (fs.existsSync(this.currentErrorLogFile)) {
				stats.errors.exists = true;
				stats.errors.size = fs.statSync(this.currentErrorLogFile).size;
			}
		} catch (error) {
			console.error('Error getting log stats:', error.message);
		}
		
		return stats;
	}
}

module.exports = FileLogger;