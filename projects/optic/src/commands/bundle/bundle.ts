import { Command, Option } from 'commander';
import { ParseResult, getFileFromFsOrGit } from '../../utils/spec-loaders';
import { OpticCliConfig } from '../../config';
import {
  OpenAPIV3,
  sourcemapReader,
  UserError,
} from '@useoptic/openapi-utilities';
import { isYaml, JsonSchemaSourcemap } from '@useoptic/openapi-io';
import fs from 'node:fs/promises';
import path from 'path';
import yaml from 'yaml';

import { errorHandler } from '../../error-handler';
import { jsonPointerHelpers } from '@useoptic/json-pointer-helpers';
import { Operation } from 'fast-json-patch';
import * as jsonpatch from 'fast-json-patch';
import sortby from 'lodash.sortby';
import { logger } from '../../logger';
const description = `dereference an OpenAPI specification`;

const usage = () => `
  optic bundle <file_path>
  optic bundle <file_path> > dereference.yml
`;
const helpText = `
Example usage:
  $ optic bundle openapi-spec.yml > bundled.yml
  `;

export const registerBundle = (cli: Command, config: OpticCliConfig) => {
  // TODO remove june 2023
  const filterXExtensions = new Option(
    '--filter-x-extensions [extensions]',
    'extensions to filter when truthy value set'
  ).hideHelp(true);
  const includeXExtensions = new Option(
    '--include-x-extensions [extensions]',
    'extensions to filter when truthy value set'
  ).hideHelp(true);

  cli
    .command('bundle')
    .configureHelp({
      commandUsage: usage,
    })
    .addHelpText('after', helpText)
    .description(description)
    .argument('[file_path]', 'openapi file to bundle')
    .option('-o [output]', 'output file name')
    .addOption(filterXExtensions)
    .addOption(includeXExtensions)
    .action(errorHandler(bundleAction(config)));
};

const getSpec = async (
  file1: string,
  config: OpticCliConfig
): Promise<ParseResult> => {
  try {
    // TODO update function to try download from spec-id cloud
    return getFileFromFsOrGit(file1, config, {
      strict: false,
      denormalize: false,
    });
  } catch (e) {
    logger.error(e instanceof Error ? e.message : e);
    throw new UserError();
  }
};

type BundleActionOptions = {
  o: string;
  filterXExtensions: string;
  includeXExtensions: string;
};

const bundleAction =
  (config: OpticCliConfig) =>
  async (filePath: string | undefined, options: BundleActionOptions) => {
    const { o, filterXExtensions, includeXExtensions } = options;

    const filterExtensions = (filterXExtensions || '')
      .split(/[ ,]+/)
      .filter((extension) => extension.startsWith('x-'));
    const includeExtensions = (includeXExtensions || '')
      .split(/[ ,]+/)
      .filter((extension) => extension.startsWith('x-'));

    let parsedFile: ParseResult;
    if (filePath) {
      parsedFile = await getSpec(filePath, config);

      const updatedSpec = bundle(parsedFile.jsonLike, parsedFile.sourcemap);

      if (includeExtensions.length) {
        Object.entries(updatedSpec.paths).forEach(([path, operations]) => {
          Object.entries(operations!).forEach(([key, operation]) => {
            if (!Object.values(OpenAPIV3.HttpMethods).includes(key as any))
              return;
            if (
              operation &&
              !includeExtensions.some((extension) =>
                Boolean(operation[extension])
              )
            ) {
              // @ts-ignore
              delete updatedSpec.paths![path]![key]!;
              const otherKeys = Object.keys(updatedSpec.paths![path] || {});
              if (
                otherKeys.length === 0 ||
                (otherKeys.length === 1 && otherKeys[0] === 'parameters')
              ) {
                delete updatedSpec.paths![path];
              }
            }
          });
        });
      }

      if (filterExtensions.length) {
        Object.entries(updatedSpec.paths).forEach(([path, operations]) => {
          Object.entries(operations!).forEach(([key, operation]) => {
            if (!Object.values(OpenAPIV3.HttpMethods).includes(key as any))
              return;
            // should filter
            if (
              operation &&
              filterExtensions.some((extension) =>
                Boolean(operation[extension])
              )
            ) {
              // @ts-ignore
              delete updatedSpec.paths![path]![key]!;
              const otherKeys = Object.keys(updatedSpec.paths![path] || {});
              if (
                otherKeys.length === 0 ||
                (otherKeys.length === 1 && otherKeys[0] === 'parameters')
              ) {
                delete updatedSpec.paths![path];
              }
            }
          });
        });
      }

      const yamlOut = () =>
        yaml.stringify(updatedSpec, {
          defaultStringType: 'QUOTE_DOUBLE',
        });

      if (o) {
        // write to file
        const outputPath = path.resolve(o);
        await fs.writeFile(
          outputPath,
          isYaml(o) ? yamlOut() : JSON.stringify(updatedSpec, null, 2)
        );
        logger.info('wrote bundled spec to ' + path.resolve(o));
      } else {
        // assume pipe >
        if (isYaml(filePath)) {
          console.log(yamlOut());
        } else {
          console.log(JSON.stringify(updatedSpec, null, 2));
        }
      }
    } else {
      logger.error('No specification found');
      process.exitCode = 1;
      return;
    }
  };

const methods = `{${Object.values(OpenAPIV3.HttpMethods).join(',')}}`;
const matches = {
  inResponseSchema: [
    'paths',
    '**',
    methods,
    'responses',
    '**',
    'content',
    '**/**',
    'schema',
  ],
  inRequestSchema: [
    'paths',
    '**',
    methods,
    'requestBody',
    'content',
    '**/**',
    'schema',
  ],
  inOperationParameterSchema: [
    'paths',
    '**',
    methods,
    'parameters',
    '**',
    'schema',
  ],
  inExistingComponent: ['components', 'schemas', '**'],
  inOperationParameter: ['paths', '**', methods, 'parameters', '**'],
  inPathParameter: ['paths', '**', 'parameters', '**'],
  inRequestExamples: [
    'paths',
    '**',
    methods,
    'requestBody',
    'content',
    '**/**',
    'examples',
    '**',
  ],
  inResponseExamples: [
    'paths',
    '**',
    methods,
    'responses',
    '**',
    'content',
    '**/**',
    'examples',
    '**',
  ],
  inRequestExample: [
    'paths',
    '**',
    methods,
    'requestBody',
    'content',
    '**/**',
    'example',
  ],
  inResponseExample: [
    'paths',
    '**',
    methods,
    'responses',
    '**',
    'content',
    '**/**',
    'example',
  ],
};
function bundle(spec: OpenAPIV3.Document, sourcemap: JsonSchemaSourcemap) {
  // create empty component objects if they do not exist
  if (!spec.components) spec.components = {};
  if (!spec.components.schemas) spec.components.schemas = {};
  if (!spec.components.parameters) spec.components.parameters = {};
  if (!spec.components.examples) spec.components.examples = {};

  let updatedSpec = spec;

  // handle schemas
  updatedSpec = bundleMatchingRefsAsComponents<OpenAPIV3.SchemaObject>(
    updatedSpec,
    sourcemap,
    [
      matches.inExistingComponent,
    ],
    'children',
    jsonPointerHelpers.compile(['components', 'schemas']),
    (schema, filePath, pathInFile) => {
      const inOtherFile = filePath !== sourcemap.rootFilePath;

      const components = jsonPointerHelpers.decode(pathInFile);

      if (inOtherFile && components.length <= 1) {
        return toComponentName(path.parse(filePath).name);
      } else {
        if (schema.title) return toComponentName(schema.title);
        const last = components[components.length - 1];
        return toComponentName(last || 'Schema');
      }
    }
  );

  // handle parameters
  updatedSpec = bundleMatchingRefsAsComponents(
    updatedSpec,
    sourcemap,
    [matches.inPathParameter, matches.inOperationParameter],
    'parent',
    jsonPointerHelpers.compile(['components', 'parameters']),
    (parameter) => {
      return (
        toComponentName(
          `${capitalize(parameter.name)}${capitalize(parameter.in)}`
        ) || 'Parameter'
      );
    }
  );

  // handle examples
  updatedSpec = bundleMatchingRefsAsComponents(
    updatedSpec,
    sourcemap,
    [
      matches.inRequestExample,
      matches.inRequestExamples,
      matches.inResponseExample,
      matches.inResponseExamples,
    ],
    'parent',
    jsonPointerHelpers.compile(['components', 'examples']),
    (example, filePath, pathInFile) => {
      const inOtherFile = filePath !== sourcemap.rootFilePath;
      const components = jsonPointerHelpers.decode(pathInFile);
      if (inOtherFile && components.length <= 1) {
        return toComponentName(path.parse(filePath).name);
      } else {
        const last = components[components.length - 1];
        return toComponentName(last || 'Example');
      }
    }
  );

  return updatedSpec;
}

function bundleMatchingRefsAsComponents<T>(
  spec: OpenAPIV3.Document,
  sourcemap: JsonSchemaSourcemap,
  matchers: string[][],
  match: 'parent' | 'children',
  targetPath: string,
  naming: (T, lookup: string, pathInFile: string) => string
) {
  const rootFileIndex = sourcemap.files.find(
    (i) => i.path === sourcemap.rootFilePath
  )!.index;

  // find all $ref usages that match the target pattern ie. in a schema?
  const matchingKeys = Object.keys(sourcemap.refMappings).filter(
    (flatSpecPath) => {
      return matchers.some((matcher) => {
        if (match === 'parent') {
          return jsonPointerHelpers.matches(flatSpecPath, matcher);
        } else {
          return (
            jsonPointerHelpers.startsWith(flatSpecPath, matcher) ||
            jsonPointerHelpers.matches(flatSpecPath, matcher)
          );
        }
      });
    }
  );

  // build a set of used names -- we don't want conflicts since the namespace is the components.{} object
  const existingComponents = jsonPointerHelpers.tryGet(spec, targetPath);
  const usedNames = new Set<string>(
    existingComponents.match
      ? (Object.keys(existingComponents.value) as string[])
      : []
  );

  // when new components are made, ensure the name is unique. If it's not unique try incrementing `_#` until it is.
  const leaseComponentPath = (name: string): string => {
    let componentName = name;
    let trailingNumber = 0;
    while (usedNames.has(componentName)) {
      componentName = name + '_' + trailingNumber;
      trailingNumber++;
    }

    usedNames.add(componentName);
    return jsonPointerHelpers.append(targetPath, componentName);
  };

  const refs: {
    [key: string]: {
      component: any;
      componentPath: string;
      circular: boolean;
      originalPath: string;
      skipAddingToComponents: boolean;
      usages: string[];
    };
  } = {};

  const addComponentOperations: Operation[] = [];
  const updateUsagesOperations: Operation[] = [];

  matchingKeys.forEach((key) => {
    const mapping = sourcemap.refMappings[key];
    const refKey = `${mapping[0].toString()}-${mapping[1]}`;
    // if the $ref has already been named, add a usage
    if (refs.hasOwnProperty(refKey)) {
      const foundRef = refs[refKey];
      // the first entry was circular, replace it
      const component = jsonPointerHelpers.get(spec, key);
      if (foundRef && foundRef.circular && !component.hasOwnProperty('$ref')) {
        foundRef.component = component;
        foundRef.originalPath = key;
        foundRef.circular = false;
      }
      foundRef.usages.push(key);
    } else {
      // if the $ref has never been seen before, add it and compute a free name
      const component = jsonPointerHelpers.get(spec, key);
      const nameOptions = naming(
        component as T,
        sourcemap.files.find((file) => file.index === mapping[0])!.path,
        mapping[1]
      );

      // this checks if the component is already in the root file of the spec
      const isAlreadyInPlace = refKey.startsWith(
        `${rootFileIndex}-${targetPath}`
      );

      refs[refKey] = {
        skipAddingToComponents: isAlreadyInPlace,
        originalPath: key,
        circular: component.hasOwnProperty('$ref'),
        componentPath: isAlreadyInPlace
          ? (() => {
              const [, lastKey] = jsonPointerHelpers.splitParentChild(
                mapping[1]
              );
              usedNames.add(lastKey);
              return mapping[1];
            })()
          : leaseComponentPath(nameOptions),
        component,
        usages: [key],
      };
    }
  });

  const refArray = Object.values(refs);
  // second pass: Nested schemas. Patch the new components we've created that rely on other newly created components.
  refArray.forEach((ref) => {
    const nestedRefs = refArray.filter((i) =>
      i.usages.some((i) => i.startsWith(ref.originalPath))
    );

    const nestedRefUsageUpdates: Operation[] = [];
    nestedRefs.forEach((nestedRef) => {
      sortby(
        nestedRef.usages
          .filter(
            (i) => i.startsWith(ref.originalPath) && i !== ref.originalPath
          )
          .map((i) => {
            const original = jsonPointerHelpers.decode(ref.originalPath);
            const newRef = jsonPointerHelpers.decode(i);
            return jsonPointerHelpers.compile(newRef.slice(original.length));
          }),
        (i) => jsonPointerHelpers.decode(i).length
      ).forEach((i) => {
        nestedRefUsageUpdates.push({
          op: 'replace',
          path: i,
          value: { $ref: '#' + nestedRef.componentPath },
        });
      });

      nestedRef.usages = nestedRef.usages.filter(
        (i) => !(i.startsWith(ref.originalPath) && i !== ref.originalPath)
      );
    });

    let copy = JSON.parse(JSON.stringify(ref.component));

    for (const patch of nestedRefUsageUpdates) {
      if (!jsonpatch.validate([patch], copy)) {
        copy = jsonpatch.applyOperation(copy, patch, true, true).newDocument;
      }
    }

    ref.component = copy;
  });

  // now generate the actual spec patches
  refArray.forEach((ref) => {
    if (!ref.skipAddingToComponents)
      addComponentOperations.push({
        op: 'add',
        path: ref.componentPath,
        value: ref.component,
      });

    ref.usages.forEach((usage) => {
      updateUsagesOperations.push({
        op: 'replace',
        path: usage,
        value: {
          $ref: '#' + ref.componentPath,
        },
      });
    });
  });

  // add components first
  let specCopy = JSON.parse(JSON.stringify(spec));

  specCopy = jsonpatch.applyPatch(
    specCopy,
    addComponentOperations,
    true,
    true
  ).newDocument;

  // then add $refs in reverse depth order (to prevent conflicts).
  const sortedUpdateOperations = sortby(
    updateUsagesOperations,
    (op) => jsonPointerHelpers.decode(op.path).length
  );

  sortedUpdateOperations.forEach((patch) => {
    const error = jsonpatch.validate([patch], specCopy);

    if (!error) {
      specCopy = jsonpatch.applyPatch(
        specCopy,
        [patch],
        true,
        true
      ).newDocument;
    }
  });

  return specCopy;
}

function toComponentName(input: string) {
  return input.replaceAll(/-/g, '_').replaceAll(/[^a-zA-Z0-9_]+/g, '');
}

function capitalize(s: string) {
  return s[0].toUpperCase() + s.slice(1);
}
