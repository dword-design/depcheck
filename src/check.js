import path from 'path';
import debug from 'debug';
import lodash from 'lodash';
import walkdir from 'walkdir';
import minimatch from 'minimatch';
import builtInModules from 'builtin-modules';
import requirePackageName from 'require-package-name';
import { loadModuleData, readJSON } from './utils';
import getNodes from './utils/parser';
import { getAtTypesName } from './utils/typescript';
import { availableParsers } from './constants';
import { getContent } from './utils/file';

function isModule(dir) {
  try {
    readJSON(path.resolve(dir, 'package.json'));
    return true;
  } catch (error) {
    return false;
  }
}

function mergeBuckets(object1, object2) {
  return lodash.mergeWith(object1, object2, (value1, value2) => {
    const array1 = value1 || [];
    const array2 = value2 || [];
    return array1.concat(array2);
  });
}

function detect(detectors, node, deps) {
  return lodash(detectors)
    .map((detector) => {
      try {
        return detector(node, deps);
      } catch (error) {
        return [];
      }
    })
    .flatten()
    .value();
}

function discoverPropertyDep(rootDir, deps, property, depName) {
  const { metadata } = loadModuleData(depName, rootDir);
  if (!metadata) return [];
  const propertyDeps = Object.keys(metadata[property] || {});
  return lodash.intersection(deps, propertyDeps);
}

function getDependencies(dir, filename, deps, parser, detectors) {
  return new Promise((resolve, reject) => {
    getContent(filename)
      .then((content) => resolve(parser(content, filename, deps, dir)))
      .catch((error) => reject(error));
  }).then((ast) => {
    // when parser returns string array, skip detector step and treat them as dependencies.
    const dependencies =
      lodash.isArray(ast) && ast.every(lodash.isString)
        ? ast
        : lodash(getNodes(ast))
            .map((node) => detect(detectors, node, deps))
            .flatten()
            .uniq()
            .map(requirePackageName)
            .thru((_dependencies) =>
              parser === availableParsers.typescript
                ? // If this is a typescript file, importing foo would also use @types/foo, but
                  // only if @types/foo is already a specified dependency.
                  lodash(_dependencies)
                    .map((dependency) => {
                      const atTypesName = getAtTypesName(dependency);
                      return deps.includes(atTypesName)
                        ? [dependency, atTypesName]
                        : [dependency];
                    })
                    .flatten()
                    .value()
                : _dependencies,
            )
            .value();

    const discover = lodash.partial(discoverPropertyDep, dir, deps);
    const discoverPeerDeps = lodash.partial(discover, 'peerDependencies');
    const discoverOptionalDeps = lodash.partial(
      discover,
      'optionalDependencies',
    );
    const peerDeps = lodash(dependencies)
      .map(discoverPeerDeps)
      .flatten()
      .value();
    const optionalDeps = lodash(dependencies)
      .map(discoverOptionalDeps)
      .flatten()
      .value();

    return lodash(dependencies)
      .concat(peerDeps)
      .concat(optionalDeps)
      .filter((dep) => dep && dep !== '.' && dep !== '..') // TODO why need check?
      .filter((dep) => !lodash.includes(builtInModules, dep))
      .uniq()
      .value();
  });
}

function checkFile(dir, filename, deps, parsers, detectors) {
  debug('depcheck:checkFile')(filename);

  const basename = path.basename(filename);
  const targets = lodash(parsers)
    .keys()
    .filter((glob) => minimatch(basename, glob, { dot: true }))
    .map((key) => parsers[key])
    .flatten()
    .value();

  return targets.map((parser) =>
    getDependencies(dir, filename, deps, parser, detectors).then(
      (using) => {
        if (using.length) {
          debug('depcheck:checkFile:using')(filename, parser, using);
        }
        return {
          using: {
            [filename]: using,
          },
        };
      },
      (error) => {
        debug('depcheck:checkFile:error')(filename, parser, error);
        return {
          invalidFiles: {
            [filename]: error,
          },
        };
      },
    ),
  );
}

function checkDirectory(dir, rootDir, ignoreDirs, deps, parsers, detectors) {
  debug('depcheck:checkDirectory')(dir);

  return new Promise((resolve) => {
    const promises = [];
    const finder = walkdir(dir, { no_recurse: true, follow_symlinks: true });

    finder.on('directory', (subdir) =>
      ignoreDirs.indexOf(path.basename(subdir)) === -1 && !isModule(subdir)
        ? promises.push(
            checkDirectory(
              subdir,
              rootDir,
              ignoreDirs,
              deps,
              parsers,
              detectors,
            ),
          )
        : null,
    );

    finder.on('file', (filename) =>
      promises.push(...checkFile(rootDir, filename, deps, parsers, detectors)),
    );

    finder.on('error', (_, error) => {
      debug('depcheck:checkDirectory:error')(dir, error);
      promises.push(
        Promise.resolve({
          invalidDirs: {
            [error.path]: error,
          },
        }),
      );
    });

    finder.on('end', () =>
      resolve(
        Promise.all(promises).then((results) =>
          results.reduce(
            (obj, current) => ({
              using: mergeBuckets(obj.using, current.using || {}),
              invalidFiles: Object.assign(
                obj.invalidFiles,
                current.invalidFiles,
              ),
              invalidDirs: Object.assign(obj.invalidDirs, current.invalidDirs),
            }),
            {
              using: {},
              invalidFiles: {},
              invalidDirs: {},
            },
          ),
        ),
      ),
    );
  });
}

function buildResult(
  result,
  deps,
  devDeps,
  peerDeps,
  optionalDeps,
  rootDir,
  prodDependencyMatches,
  skipMissing,
) {
  const mapToDependencies = (using) =>
    lodash(using)
      // { f1:[d1,d2,d3], f2:[d2,d3,d4] }
      .toPairs()
      // [ [f1,[d1,d2,d3]], [f2,[d2,d3,d4]] ]
      .map(([file, dep]) => [dep, lodash.times(dep.length, () => file)])
      // [ [ [d1,d2,d3],[f1,f1,f1] ], [ [d2,d3,d4],[f2,f2,f2] ] ]
      .map((pairs) => lodash.zip(...pairs))
      // [ [ [d1,f1],[d2,f1],[d3,f1] ], [ [d2,f2],[d3,f2],[d4,f2]] ]
      .flatten()
      // [ [d1,f1], [d2,f1], [d3,f1], [d2,f2], [d3,f2], [d4,f2] ]
      .groupBy(([dep]) => dep)
      // { d1:[ [d1,f1] ], d2:[ [d2,f1],[d2,f2] ], d3:[ [d3,f1],[d3,f2] ], d4:[ [d4,f2] ] }
      .mapValues((pairs) => pairs.map(lodash.last))
      // { d1:[ f1 ], d2:[ f1,f2 ], d3:[ f1,f2 ], d4:[ f2 ] }
      .value();

  const usingProdDepsLookup = mapToDependencies(
    lodash.pickBy(
      result.using,
      (dep, file) =>
        prodDependencyMatches.length === 0 ||
        prodDependencyMatches.some((pattern) =>
          minimatch(path.relative(rootDir, file), pattern),
        ),
    ),
  );

  const usingAllDepsLookup = mapToDependencies(result.using);

  const usingProdDeps = Object.keys(usingProdDepsLookup);
  const usingAllDeps = Object.keys(usingAllDepsLookup);

  const missingDepsLookup = skipMissing
    ? []
    : (() => {
        const allDeps = deps
          .concat(devDeps)
          .concat(peerDeps)
          .concat(optionalDeps);

        const missingDeps = lodash.difference(usingProdDeps, allDeps);
        return lodash(missingDeps)
          .map((missingDep) => [missingDep, usingProdDepsLookup[missingDep]])
          .fromPairs()
          .value();
      })();

  return {
    dependencies: lodash.difference(deps, usingProdDeps),
    devDependencies: lodash.difference(devDeps, usingAllDeps),
    missing: missingDepsLookup,
    using: usingAllDepsLookup,
    invalidFiles: result.invalidFiles,
    invalidDirs: result.invalidDirs,
  };
}

export default function check({
  rootDir,
  ignoreDirs,
  prodDependencyMatches,
  skipMissing,
  deps,
  devDeps,
  peerDeps,
  optionalDeps,
  parsers,
  detectors,
}) {
  const allDeps = lodash.union(deps, devDeps);
  return checkDirectory(
    rootDir,
    rootDir,
    ignoreDirs,
    allDeps,
    parsers,
    detectors,
  ).then((result) =>
    buildResult(
      result,
      deps,
      devDeps,
      peerDeps,
      optionalDeps,
      rootDir,
      prodDependencyMatches,
      skipMissing,
    ),
  );
}
