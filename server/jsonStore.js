'use strict';

const fs = require('fs');
const path = require('path');

// Minimal JSON-file read/write helper for /config/*.json stores.
class JsonStore {
  constructor(filePath, defaults) {
    this.filePath = filePath;
    this.defaults = defaults;
  }

  read() {
    try {
      const raw = fs.readFileSync(this.filePath, 'utf8');
      return JSON.parse(raw);
    } catch (err) {
      if (err.code !== 'ENOENT') {
        console.error(`jsonStore: failed reading ${this.filePath}: ${err.message}`);
      }
      return structuredClone(this.defaults);
    }
  }

  write(data) {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
    fs.renameSync(tmp, this.filePath);
    return data;
  }
}

module.exports = { JsonStore };
