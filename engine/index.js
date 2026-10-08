'use strict';

const path = require('path');
const fs = require('fs');

function load() {
  const candidates = [
    path.join(__dirname, 'build', 'Release', 'harbor_engine.node'),
    path.join(__dirname, 'build', 'Debug', 'harbor_engine.node'),
    path.join(__dirname, 'build', 'harbor_engine.node'),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return require(candidate);
    }
  }
  throw new Error(
    'harbor_engine.node not found. Run: npm run build -w @harbor/engine'
  );
}

module.exports = load();
