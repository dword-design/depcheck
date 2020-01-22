"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.clearCache = clearCache;
exports.default = getScripts;

var _path = _interopRequireDefault(require("path"));

var _jsYaml = _interopRequireDefault(require("js-yaml"));

var _lodash = _interopRequireDefault(require("lodash"));

function _interopRequireDefault(obj) { return obj && obj.__esModule ? obj : { default: obj }; }

const scriptCache = {};

function clearCache() {
  Object.keys(scriptCache).forEach(key => {
    scriptCache[key] = undefined;
  });
}

function getCacheOrFile(key, fn) {
  if (scriptCache[key]) {
    return scriptCache[key];
  }

  const value = fn();
  scriptCache[key] = value;
  return value;
}

const travisCommands = [// Reference: https://docs.travis-ci.com/user/job-lifecycle
'before_install', 'install', 'before_script', 'script', 'before_cache', 'after_success', 'after_failure', 'before_deploy', // 'deploy', // currently ignored
'after_deploy', 'after_script'];

function getScripts(filepath, content) {
  return getCacheOrFile(filepath, () => {
    const basename = _path.default.basename(filepath);

    if (basename === 'package.json') {
      return _lodash.default.values(JSON.parse(content).scripts || {});
    }

    if (basename === '.travis.yml') {
      const metadata = _jsYaml.default.safeLoad(content) || {};
      return (0, _lodash.default)(travisCommands).map(cmd => metadata[cmd] || []).flatten().value();
    }

    return [];
  });
}