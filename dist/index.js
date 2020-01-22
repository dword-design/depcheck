"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.default = depcheck;

var _fs = _interopRequireDefault(require("fs"));

var _path = _interopRequireDefault(require("path"));

var _lodash = _interopRequireDefault(require("lodash"));

var _minimatch = _interopRequireDefault(require("minimatch"));

var _check = _interopRequireDefault(require("./check"));

var _utils = require("./utils");

var _constants = require("./constants");

function _interopRequireDefault(obj) { return obj && obj.__esModule ? obj : { default: obj }; }

function _extends() { _extends = Object.assign || function (target) { for (var i = 1; i < arguments.length; i++) { var source = arguments[i]; for (var key in source) { if (Object.prototype.hasOwnProperty.call(source, key)) { target[key] = source[key]; } } } return target; }; return _extends.apply(this, arguments); }

function registerTs(rootDir) {
  if (!require.extensions['.ts']) {
    const ts = (0, _utils.tryRequire)('typescript', [rootDir, process.cwd(), __dirname]);

    if (ts) {
      require.extensions['.ts'] = (module, filename) => {
        const content = _fs.default.readFileSync(filename, 'utf8');

        const options = (0, _utils.tryRequire)(_path.default.join(rootDir, 'package.json')) || {};
        options.fileName = filename;
        const transpiled = ts.transpileModule(content.charCodeAt(0) === 0xfeff ? content.slice(1) : content, options); // eslint-disable-next-line no-underscore-dangle

        module._compile(transpiled.outputText, filename);
      };
    }
  }
}

function isIgnored(ignoreMatches, dependency) {
  const match = _lodash.default.partial(_minimatch.default, dependency);

  return ignoreMatches.some(match);
}

function hasBin(rootDir, dependency) {
  const {
    metadata
  } = (0, _utils.loadModuleData)(dependency, rootDir);
  return !!metadata && {}.hasOwnProperty.call(metadata, 'bin');
}

function filterDependencies(rootDir, ignoreBinPackage, ignoreMatches, dependencies) {
  return (0, _lodash.default)(dependencies).keys().reject(dep => isIgnored(ignoreMatches, dep) || ignoreBinPackage && hasBin(rootDir, dep)).value();
}

function depcheck(rootDir, options, callback) {
  registerTs(rootDir);

  const getOption = key => _lodash.default.isUndefined(options[key]) ? _constants.defaultOptions[key] : options[key];

  const ignoreBinPackage = getOption('ignoreBinPackage');
  const ignoreMatches = getOption('ignoreMatches');

  const ignoreDirs = _lodash.default.union(_constants.defaultOptions.ignoreDirs, options.ignoreDirs);

  const prodDependencyMatches = getOption('prodDependencyMatches');
  const skipMissing = getOption('skipMissing');
  const detectors = getOption('detectors');
  const parsers = (0, _lodash.default)(getOption('parsers')).mapValues(value => _lodash.default.isArray(value) ? value : [value]).merge({
    '*': getOption('specials')
  }).value();
  const metadata = options.package || (0, _utils.readJSON)(_path.default.join(rootDir, 'package.json'));
  const dependencies = metadata.dependencies || {};
  const devDependencies = metadata.devDependencies ? metadata.devDependencies : {};
  const peerDeps = Object.keys(metadata.peerDependencies || {});
  const optionalDeps = Object.keys(metadata.optionalDependencies || {});
  const deps = filterDependencies(rootDir, ignoreBinPackage, ignoreMatches, dependencies);
  const devDeps = filterDependencies(rootDir, ignoreBinPackage, ignoreMatches, devDependencies);
  return (0, _check.default)({
    rootDir,
    ignoreDirs,
    prodDependencyMatches,
    skipMissing,
    deps,
    devDeps,
    peerDeps,
    optionalDeps,
    parsers,
    detectors
  }).then(results => _extends(results, {
    missing: _lodash.default.pick(results.missing, filterDependencies(rootDir, ignoreBinPackage, ignoreMatches, results.missing))
  })).then(callback);
}

depcheck.parser = _constants.availableParsers;
depcheck.detector = _constants.availableDetectors;
depcheck.special = _constants.availableSpecials;
module.exports = exports.default;