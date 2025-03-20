const fs = require('fs');
const { v4: uuidv4 } = require('uuid');

function loadJSON(filename) {
  try {
    const data = fs.readFileSync(filename, 'utf8');
    return JSON.parse(data);
  } catch (err) {
    if (err.code === 'ENOENT') {
      return filename === 'users.json' ? [] : {}; // Return empty array for users, object for others
    }
    console.error(`Error reading ${filename}:`, err);
    return null; // Or appropriate default/error handling
  }
}

function saveJSON(filename, data) {
  try {
    fs.writeFileSync(filename, JSON.stringify(data, null, 2), 'utf8');
  } catch (err) {
    console.error(`Error writing ${filename}:`, err);
  }
}

function generateUserId() {
  return uuidv4();
}

module.exports = { loadJSON, saveJSON, generateUserId };
