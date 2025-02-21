import {
  groupDiffsByEndpoint,
  compareSpecs,
} from '@useoptic/openapi-utilities';
import { generateRuleRunner } from './generate-rule-runner';
import { OPTIC_STANDARD_KEY } from '../../constants';
import {
  getFileFromFsOrGit,
  ParseResult,
  parseSpecVersion,
} from '../../utils/spec-loaders';
import { OpticCliConfig } from '../../config';
import { trackEvent } from '@useoptic/openapi-utilities/build/utilities/segment';
import { logger } from '../../logger';

let generateContext: (file: string) => any = () => ({});

export function setGenerateContext(fn: (file: string) => any) {
  generateContext = fn;
}

export async function compute(
  [baseFile, headFile]: [ParseResult, ParseResult],
  config: OpticCliConfig,
  options: {
    standard?: string;
    check: boolean;
    path: string | null;
  }
) {
  const { runner, ruleNames, warnings } = await generateRuleRunner(
    {
      rulesetArg: options.standard,
      specRuleset: headFile.isEmptySpec
        ? baseFile.jsonLike[OPTIC_STANDARD_KEY]
        : headFile.jsonLike[OPTIC_STANDARD_KEY],
      config,
    },
    options.check
  );

  trackEvent('diff.rulesets', {
    ruleset: ruleNames,
  });

  let context = {};
  if (process.env.OPTIC_DIFF_CONTEXT) {
    try {
      context = JSON.parse(process.env.OPTIC_DIFF_CONTEXT);
    } catch (e) {
      logger.error('Error generating context');
      logger.error(e);
    }
  } else {
    const parsed = parseSpecVersion(options.path);
    const filePath =
      parsed.from === 'git'
        ? parsed.name
        : parsed.from === 'file'
        ? parsed.filePath
        : null;
    if (filePath) {
      try {
        context = generateContext(filePath);
      } catch (e) {
        logger.error('Error generating context');
        logger.error(e);
      }
    }
  }
  const specResults = await compareSpecs(baseFile, headFile, runner, context);

  const changelogData = groupDiffsByEndpoint(
    {
      from: baseFile.jsonLike,
      to: headFile.jsonLike,
    },
    specResults.diffs
  );

  return {
    warnings,
    specResults,
    changelogData,
    checks: {
      total: specResults.results.length,
      passed: specResults.results.filter((check) => check.passed).length,
      failed: specResults.results.filter(
        (check) => !check.passed && !check.exempted
      ).length,
    },
  };
}
