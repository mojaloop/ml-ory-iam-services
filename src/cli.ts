#!/usr/bin/env node

import { Command } from 'commander';
import { config } from 'dotenv';

config();

const program = new Command();

program.name('ory-services').description('Mojaloop Ory IAM Services').version('0.1.0');

program
  .command('keto-batch-auth')
  .description('Start the Keto batch authorization proxy')
  .action(async () => {
    await import('./keto-batch-auth/server');
  });

program
  .command('kratos-role-webhook')
  .description('Start the Kratos role injection webhook')
  .action(async () => {
    await import('./kratos-role-webhook/server');
  });

program.parse();
