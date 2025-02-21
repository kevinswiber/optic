import { OpenAPIV3, OpenAPI } from 'openapi-types';
import ajv, { ValidateFunction, ErrorObject } from 'ajv';

import addFormats from 'ajv-formats';

import {
  openapi3_1_json_schema,
  openapi3_0_json_schema,
} from './validation-schemas';
import { checkOpenAPIVersion } from './openapi-versions';
import ajvErrors from 'ajv-errors';
import chalk from 'chalk';
import { jsonPointerLogger } from './log-json-pointer';
import { JsonSchemaSourcemap } from '../parser/sourcemap';
import { attachAdvancedValidators } from './advanced-validation';
import { ValidationError } from './errors';
import { jsonPointerHelpers } from '@useoptic/json-pointer-helpers';

type Options = {
  strictOpenAPI: boolean;
};

export default class OpenAPISchemaValidator {
  private v3_0Validator: ValidateFunction | undefined;
  private v3_1Validator: ValidateFunction | undefined;

  constructor(private options: Options) {}

  public validate3_0(openapiDoc: OpenAPI.Document): {
    errors: ErrorObject[];
  } {
    if (!this.v3_0Validator) {
      const v = new ajv({ allErrors: true, strict: false });
      ajvErrors(v);
      addFormats(v);
      if (this.options.strictOpenAPI) attachAdvancedValidators(v);
      v.addSchema(openapi3_0_json_schema);
      this.v3_0Validator = v.compile(openapi3_0_json_schema);
    }

    if (!this.v3_0Validator(openapiDoc) && this.v3_0Validator.errors) {
      return { errors: this.v3_0Validator.errors };
    } else {
      return { errors: [] };
    }
  }
  public validate3_1(openapiDoc: OpenAPI.Document): {
    errors: ErrorObject[];
  } {
    if (!this.v3_1Validator) {
      const v = new ajv({ allErrors: true, strict: false });
      ajvErrors(v);
      addFormats(v);
      if (this.options.strictOpenAPI) attachAdvancedValidators(v);
      v.addSchema(openapi3_1_json_schema);
      this.v3_1Validator = v.compile(openapi3_1_json_schema);
    }

    if (!this.v3_1Validator(openapiDoc) && this.v3_1Validator.errors) {
      return { errors: this.v3_1Validator.errors };
    } else {
      return { errors: [] };
    }
  }
}

const getReadableError = (error: ErrorObject): string => {
  if (error.keyword === 'enum') {
    const paths = error.instancePath.split('/');
    const key = paths[paths.length - 1];
    return `${key} ${error.message} ${error.params.allowedValues.join(',')}`;
  } else {
    const readableJsonPath = jsonPointerHelpers
      .decode(error.instancePath)
      .join(' > ');
    return `${readableJsonPath} ${error.message}` ?? '';
  }
};

export const processValidatorErrors = (
  spec: any,
  errors: ErrorObject[],
  sourcemap?: JsonSchemaSourcemap
): string[] => {
  const sortedErrorsByLength = errors.sort(
    (a, b) => b.instancePath.length - a.instancePath.length
  );
  const pathsWithErrors: ErrorObject[] = [];

  for (const error of sortedErrorsByLength) {
    // We want to only render the root of the error message
    if (
      pathsWithErrors.every(
        (addedError) => !addedError.instancePath.startsWith(error.instancePath)
      ) ||
      error.keyword === 'x-custom-validator'
    ) {
      pathsWithErrors.push(error);
    }
  }

  const logger = sourcemap && jsonPointerLogger(sourcemap);

  return pathsWithErrors
    .map((error) => {
      const pathToLog =
        error.keyword === 'additionalProperties'
          ? jsonPointerHelpers.append(
              error.instancePath,
              error.params.additionalProperty
            )
          : error.instancePath;

      const preview = logger ? logger.log(pathToLog) : `${error.instancePath}`;

      return `${chalk.red('invalid openapi: ')}${chalk.bold.red(
        getReadableError(error)
      )}\n${preview}`;
    })
    .filter((value, index, array) => array.indexOf(value) === index);
};

export const validateOpenApiV3Document = (
  spec: any,
  sourcemap?: JsonSchemaSourcemap,
  validatorOptions: Options = { strictOpenAPI: true }
): OpenAPIV3.Document => {
  const validator = new OpenAPISchemaValidator(validatorOptions);

  let results:
    | {
        errors: ErrorObject[];
      }
    | undefined = undefined;
  // will throw for unsupported spec version before running
  const version = checkOpenAPIVersion(spec);

  if (version === '3.0.x') results = validator.validate3_0(spec);
  if (version === '3.1.x') results = validator.validate3_1(spec);

  if (results && results.errors.length > 0) {
    const processedErrors = processValidatorErrors(
      spec,
      results.errors,
      sourcemap
    );

    throw new ValidationError(processedErrors.join('\n'));
  }

  return spec as OpenAPIV3.Document;
};
