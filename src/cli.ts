#!/usr/bin/env node

import { readFileSync } from 'node:fs';

import { Command } from 'commander';
import { config } from 'dotenv';
import { parse as parseYaml } from 'yaml';

import {
  composeToDir,
  diffCatalogs,
  generateToDir,
  Migrations,
  ResourceNames,
  ServiceCatalog,
  ServiceRegistration,
  ungated,
} from './authzgen/index';
import { start as startCapabilities } from './capabilities/server';
import { start as startDecision } from './decision/server';
import { start as startProvisioning } from './iam/server';
import { start as startKetoBatchAuth } from './keto-batch-auth/server';
import { start as startKratosRoleWebhook } from './kratos-role-webhook/server';
import { readRegistry } from './operator/sources';

config();

const program = new Command();

program.name('ory-services').description('Mojaloop Ory IAM Services').version('0.1.0');

program
  .command('keto-batch-auth')
  .description('Start the Keto batch authorization proxy')
  .action(startKetoBatchAuth);

program
  .command('kratos-role-webhook')
  .description('Start the Kratos role injection webhook')
  .action(startKratosRoleWebhook);

program
  .command('capabilities')
  .description('Start the capabilities service')
  .action(startCapabilities);

program
  .command('decide')
  .description('Start the decision endpoint the gateway asks for every request')
  .action(startDecision);

program
  .command('provisioning')
  .description("Apply the deployment's roles, then serve the IAM the role UI and services call")
  .requiredOption('-r, --roles <path>', 'path to the role document')
  .option(
    '-c, --catalog <path...>',
    'composed catalogs to read, when it composes no namespace of its own',
  )
  .option('--migrations <path>', 'where the grants of a renamed or retired permission go')
  .option(
    '--admin-email <email>',
    'identity to create and add to the admin role',
    process.env.IAM_ADMIN_EMAIL,
  )
  .option(
    '--admin-password <password>',
    'password for that identity, invited by email to set one when omitted',
    process.env.IAM_ADMIN_PASSWORD,
  )
  .option('--admin-role <role>', 'role that identity joins', process.env.IAM_HUB_ADMIN_ROLE)
  .option('--kratos-admin-url <url>', 'Kratos admin API', process.env.KRATOS_ADMIN_URL)
  .option(
    '--kratos-public-url <url>',
    'Kratos public API, where the invitation flow starts',
    process.env.KRATOS_PUBLIC_URL,
  )
  .option(
    '--namespace <namespace>',
    'namespace whose AuthzDocuments this reconciles',
    process.env.POD_NAMESPACE,
  )
  .option('--registry <path>', 'a registry of documents the chart mounted, composed with them')
  .option('--resource-names <path>', "the deployment's names for one thing across services")
  .option('--publish-as <name>', 'ConfigMap the composed rules and catalog are published as')
  .action(startProvisioning);

program
  .command('authzgen')
  .description('Generate the authz bundle from an annotated OpenAPI document')
  .requiredOption('-s, --spec <path>', 'path to the OpenAPI document')
  .requiredOption('-o, --out <dir>', 'directory to write the bundle into')
  .option('-H, --host <host>', 'host the service is served on')
  .option('-p, --path <path>', 'mount path when served under a prefix')
  .option('-n, --resource-names <path>', "the deployment's names for one thing across services")
  .action(
    async (options: {
      spec: string;
      out: string;
      host?: string;
      path?: string;
      resourceNames?: string;
    }) => {
      const names: ResourceNames = options.resourceNames
        ? (parseYaml(readFileSync(options.resourceNames, 'utf8')) as ResourceNames)
        : {};
      const bundle = await generateToDir(
        options.spec,
        options.out,
        {
          host: options.host,
          path: options.path,
        },
        names,
      );
      console.log(
        `${bundle.service}: ${bundle.permissions.length} operations, ` +
          `resource types [${bundle.resourceTypes.join(', ')}] -> ${options.out}`,
      );
    },
  );

program
  .command('compose')
  .description("Stage every registered service's authz surface for one rollout")
  .requiredOption(
    '-r, --registry <path>',
    'the services this deployment runs, with where each is served',
  )
  .requiredOption('-o, --out <dir>', 'directory to stage into')
  .option('-n, --resource-names <path>', "the deployment's names for one thing across services")
  .option(
    '-p, --previous <path>',
    'the catalog this rollout replaces, to see what it does to existing grants',
  )
  .option('-m, --migrations <path>', 'where the grants of a removed or changed permission go')
  .action(
    async (options: {
      registry: string;
      out: string;
      resourceNames?: string;
      previous?: string;
      migrations?: string;
    }) => {
      const read = <T>(path: string): T => parseYaml(readFileSync(path, 'utf8')) as T;
      const registry = readRegistry(
        readFileSync(options.registry, 'utf8'),
        options.registry,
      ) as ServiceRegistration[];
      const names: ResourceNames = options.resourceNames ? read(options.resourceNames) : {};

      const composition = await composeToDir(registry, options.out, names);
      for (const service of Object.keys(composition.rules)) {
        const catalog = composition.catalog.find((c) => c.service === service)!;
        console.log(`${service}: ${catalog.permissions.length} permissions`);
      }

      if (options.previous !== undefined) {
        const diff = diffCatalogs(read<ServiceCatalog[]>(options.previous), composition.catalog);
        const migrations: Migrations = options.migrations ? read(options.migrations) : {};
        for (const id of diff.added) console.log(`  + ${id}`);
        for (const id of diff.removed) console.log(`  - ${id} -> ${migrations[id] ?? 'nowhere'}`);
        for (const c of diff.changed) console.log(`  ~ ${c.id}: ${c.was} -> ${c.now}`);
        composition.problems.push(...ungated(diff, migrations));
      }

      if (composition.problems.length > 0) {
        console.error(
          `\nthis deployment does not compose:\n  ${composition.problems.join('\n  ')}`,
        );
        process.exit(1);
      }
      console.log(`\nStaged into ${options.out}`);
    },
  );

program.parse();
