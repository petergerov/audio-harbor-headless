'use strict';

const { spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const root = path.join(__dirname, '..');
const buildDir = path.join(root, 'build');

function run(cmd, args, opts = {}) {
  console.log(`> ${cmd} ${args.join(' ')}`);
  const result = spawnSync(cmd, args, {
    cwd: root,
    stdio: 'inherit',
    shell: process.platform === 'win32',
    ...opts,
  });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

fs.mkdirSync(buildDir, { recursive: true });

const napiInclude = require('node-addon-api').include.replace(/\\/g, '/');

// Prefer cmake-js if available for correct Node include/lib dirs
const cmakeJs = path.join(root, 'node_modules', 'cmake-js', 'bin', 'cmake-js');
const cmakeJsRoot = path.join(root, '..', 'node_modules', 'cmake-js', 'bin', 'cmake-js');
const cmakeJsBin = fs.existsSync(cmakeJs)
  ? cmakeJs
  : fs.existsSync(cmakeJsRoot)
    ? cmakeJsRoot
    : null;

// Drop a stale JUCE-era cache so the first native-only configure succeeds.
const cachePath = path.join(buildDir, 'CMakeCache.txt');
if (fs.existsSync(cachePath)) {
  const cache = fs.readFileSync(cachePath, 'utf8');
  if (/HARBOR_WITH_JUCE|juce::|JUCE_/.test(cache)) {
    console.log('Clearing engine/build cache (JUCE removed)');
    fs.rmSync(buildDir, { recursive: true, force: true });
    fs.mkdirSync(buildDir, { recursive: true });
  }
}

if (cmakeJsBin) {
  run(process.execPath, [cmakeJsBin, 'compile', '-d', root, '--out', 'build']);
} else {
  run('cmake', [
    '-S',
    root,
    '-B',
    buildDir,
    `-DNAPI_INCLUDE_DIR=${napiInclude}`,
    `-DCMAKE_BUILD_TYPE=Release`,
  ]);
  run('cmake', ['--build', buildDir, '--config', 'Release', '-j']);
}

console.log('Engine build complete.');
