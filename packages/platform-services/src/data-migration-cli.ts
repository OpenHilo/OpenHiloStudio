#!/usr/bin/env node
import { migrateDataCopy, migrateBrainDirectoriesCopy, planBrainDirectoryMigration, restoreMigrationBackup } from './data-migration';
import { migrateConfigurationCopy } from './deployment-config';
import { inspectMigrationSource } from './migration-inspection';
import { planPathRebinding, migratePathsCopy, type PathMapping, type PathRebindingPlan } from './path-migration';
import * as fs from 'fs';
import * as path from 'path';

function readJson(file: string): unknown {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { throw new Error('Could not read a valid migration JSON document'); }
}

export async function main(argv: string[]): Promise<void> {
  const [command, ...args] = argv;
  const flags = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index], value = args[index + 1];
    if (!['--source', '--bundle', '--destination', '--plan', '--mappings'].includes(key) || !value || value.startsWith('--') || flags.has(key)) throw new Error('Expected unique path flags with explicit absolute paths');
    flags.set(key, value);
  }
  const value = (key: string) => {
    const result = flags.get(key);
    if (!result || !path.isAbsolute(result)) throw new Error(`${key} requires an explicit absolute path`);
    return result;
  };
  if (command === 'plan-paths' && [3, 4].includes(flags.size) && flags.has('--source') && flags.has('--bundle') && flags.has('--plan') && (flags.size === 3 || flags.has('--mappings'))) {
    const mappings = flags.has('--mappings') ? readJson(value('--mappings')) as PathMapping[] : undefined;
    const plan = planPathRebinding({ sourceDir: value('--source'), bundleDir: value('--bundle'), mappings });
    const planFile = path.join(fs.realpathSync(path.dirname(value('--plan'))), path.basename(value('--plan')));
    const relative = path.relative(fs.realpathSync(plan.sourceDir), planFile);
    if (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)) throw new Error('Save the migration plan outside the source directory');
    fs.writeFileSync(planFile, JSON.stringify(plan, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    console.log(JSON.stringify({ status: 'planned', activation: plan.activation, plan: value('--plan'), files: plan.files.length, unresolved: plan.unresolved.length }));
  } else if (command === 'migrate-paths' && flags.size === 2 && flags.has('--plan') && flags.has('--bundle')) {
    const plan = readJson(value('--plan')) as PathRebindingPlan;
    const report = await migratePathsCopy({ plan, bundleDir: value('--bundle') });
    console.log(JSON.stringify({ status: report.status, activation: report.activation, bundle: value('--bundle'), report: path.join(value('--bundle'), 'report.json') }));
  } else if (command === 'inspect' && flags.size === 1 && flags.has('--source')) {
    console.log(JSON.stringify(inspectMigrationSource({ sourceDir: value('--source') }), null, 2));
  } else if (command === 'plan-brain' && flags.size === 1 && flags.has('--source')) {
    console.log(JSON.stringify({ changes: planBrainDirectoryMigration(value('--source')) }, null, 2));
  } else if ((command === 'migrate-brain' || command === 'migrate-config' || command === 'copy') && flags.size === 2 && flags.has('--source') && flags.has('--bundle')) {
    const options = { sourceDir: value('--source'), bundleDir: value('--bundle') };
    const report = command === 'copy' ? await migrateDataCopy({ ...options, steps: [] })
      : command === 'migrate-config' ? await migrateConfigurationCopy(options) : await migrateBrainDirectoriesCopy(options);
    console.log(JSON.stringify({ status: report.status, activation: report.activation, bundle: value('--bundle'), report: path.join(value('--bundle'), 'report.json') }, null, 2));
  } else if (command === 'restore' && flags.size === 2 && flags.has('--bundle') && flags.has('--destination')) {
    restoreMigrationBackup(value('--bundle'), value('--destination'));
    console.log(JSON.stringify({ status: 'restored', destination: value('--destination') }, null, 2));
  } else throw new Error('Usage: intentorch-migrate inspect --source ABS | copy --source ABS --bundle NEW_ABS | plan-brain --source ABS | migrate-brain --source ABS --bundle NEW_ABS | migrate-config --source ABS --bundle NEW_ABS | plan-paths --source ABS --bundle NEW_ABS --plan NEW_ABS [--mappings ABS] | migrate-paths --plan ABS --bundle NEW_ABS | restore --bundle ABS --destination NEW_ABS');
}
if (require.main === module) main(process.argv.slice(2)).catch(error => { console.error(error instanceof Error ? error.message : 'Migration failed'); process.exitCode = 1; });
