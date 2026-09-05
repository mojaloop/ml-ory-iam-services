import { loadSpec } from '../../src/authzgen/index';
import { derive } from '../../src/authzgen/derive';

async function main(): Promise<void> {
  for (const rel of process.argv.slice(2)) {
    try {
      const bundle = derive(await loadSpec(rel));
      console.log(`${rel}: OK resourceTypes=[${bundle.resourceTypes}]`);
    } catch (e) {
      console.log(`${rel}: ${(e as Error).message}`);
    }
  }
}
void main();
