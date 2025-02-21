import { UserError } from '@useoptic/openapi-utilities';
import { SentryClient } from '@useoptic/openapi-utilities/build/utilities/sentry';
import chalk from 'chalk';
import { BadRequestError, ForbiddenError } from './client/errors';
import { logger } from './logger';

export const errorHandler = <Args extends any[], Return extends any>(
  fn: (...args: Args) => Promise<Return>
): ((...args: Args) => Promise<Return>) => {
  return async (...args) => {
    try {
      return await fn(...args);
    } catch (e) {
      if (UserError.isInstance(e)) {
        console.error(e.message);
      } else if (
        (e instanceof BadRequestError &&
          e.source === 'optic' &&
          /Invalid token/i.test(e.message)) ||
        (e instanceof ForbiddenError && e.source === 'optic')
      ) {
        logger.error('');
        logger.error(chalk.red.bold('Error making request to Optic'));
        logger.error(
          chalk.red(
            'It looks like your token is invalid (this could mean your token has expired, or it has been revoked).'
          )
        );
        logger.error('');
        logger.error(chalk.green('Run optic login to generate a new token'));
      } else {
        console.error(chalk.red((e as Error).message));
        SentryClient.captureException(e);
        await SentryClient.flush();
      }

      process.exit(1);
    }
  };
};
