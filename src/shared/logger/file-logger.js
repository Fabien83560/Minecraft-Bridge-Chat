const fs = require('fs');
const path = require('path');

class FileLogger {
	constructor() {
		this.logDir = path.join(__dirname, '../../../data/logs');
		this.maxFileSize = 10 * 1024 * 1024; // 10MB
		this.maxFiles = 5;
		
		this.ensureLogDirectory();
		this.currentLogFile = this.getLogFileName();
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
	
	write(level, message) {
		try {
		// Check if we need a new file (new day)
		const currentFileName = this.getLogFileName();
		if (currentFileName !== this.currentLogFile) {
			this.currentLogFile = currentFileName;
		}
		
		// Check file size and rotate if needed
		this.rotateIfNeeded();
		
		// Write message
		const logEntry = `${message}\n`;
		fs.appendFileSync(this.currentLogFile, logEntry, 'utf8');
		
		} catch (error) {
			// In case of write error, log to console only
			console.error('Failed to write to log file:', error.message);
		}
	}
	
	rotateIfNeeded() {
		try {
			if (!fs.existsSync(this.currentLogFile)) {
				return;
			}
			
			const stats = fs.statSync(this.currentLogFile);
			if (stats.size > this.maxFileSize) {
				this.rotateLogFile();
			}
		} catch (error) {
			console.error('Error checking log file size:', error.message);
		}
	}
	
	rotateLogFile() {
		try {
			const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
			const rotatedFileName = this.currentLogFile.replace('.log', `-${timestamp}.log`);
			
			// Rename current file
			fs.renameSync(this.currentLogFile, rotatedFileName);
			
			// Clean old files
			this.cleanOldLogFiles();
			
		} catch (error) {
			console.error('Error rotating log file:', error.message);
		}
	}
	
	cleanOldLogFiles() {
		try {
			const files = fs.readdirSync(this.logDir)
				.filter(file => file.startsWith('bridge-') && file.endsWith('.log'))
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
			console.error('Error cleaning old log files:', error.message);
		}
	}
	
	// Method to get recent logs
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
}

module.exports = FileLogger;