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
const nodeApiInclude = path.dirname(process.execPath).includes('bin')
  ? path.join(path.dirname(path.dirname(process.execPath)), 'include', 'node')
  : '';

// Prefer cmake-js if available for correct Node include/lib dirs
const cmakeJs = path.join(root, 'node_modules', 'cmake-js', 'bin', 'cmake-js');
const cmakeJsRoot = path.join(root, '..', 'node_modules', 'cmake-js', 'bin', 'cmake-js');
const cmakeJsBin = fs.existsSync(cmakeJs)
  ? cmakeJs
  : fs.existsSync(cmakeJsRoot)
    ? cmakeJsRoot
    : null;

// Default ON: ship JUCE + native (Mac/Linux/Windows). HARBOR_WITH_JUCE=0 → native-only.
const juceEnv = process.env.HARBOR_WITH_JUCE;
const withJuce = juceEnv !== '0' && juceEnv !== 'OFF';

// cmake-js --CD… does not override a cached BOOL; wipe cache when it disagrees.
const cachePath = path.join(buildDir, 'CMakeCache.txt');
if (fs.existsSync(cachePath)) {
  const cache = fs.readFileSync(cachePath, 'utf8');
  const cachedOff = /HARBOR_WITH_JUCE:BOOL=OFF/.test(cache);
  const cachedOn = /HARBOR_WITH_JUCE:BOOL=ON/.test(cache);
  if ((withJuce && cachedOff) || (!withJuce && cachedOn)) {
    console.log('HARBOR_WITH_JUCE changed — clearing engine/build cache');
    fs.rmSync(buildDir, { recursive: true, force: true });
    fs.mkdirSync(buildDir, { recursive: true });
  }
}

if (cmakeJsBin) {
  const args = [cmakeJsBin, 'compile', '-d', root, '--out', 'build'];
  if (withJuce) args.push('--CDHARBOR_WITH_JUCE=ON');
  else args.push('--CDHARBOR_WITH_JUCE=OFF');
  run(process.execPath, args);
} else {
  run('cmake', [
    '-S',
    root,
    '-B',
    buildDir,
    `-DNAPI_INCLUDE_DIR=${napiInclude}`,
    `-DCMAKE_BUILD_TYPE=Release`,
    `-DHARBOR_WITH_JUCE=${withJuce ? 'ON' : 'OFF'}`,
  ]);
  run('cmake', ['--build', buildDir, '--config', 'Release', '-j']);
}

console.log('Engine build complete.');
