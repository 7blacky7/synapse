/** Native-Probe-Fixture: ausschließlich eigene coedit-mkdtemp-Wurzel. */
import {mkdtemp} from 'node:fs/promises';
import {join} from 'node:path';
export function createTestFixtureCleanup(){
 const base=join(process.cwd(),'coedit-test');
 const createRoot=async prefix=>{const created=await mkdtemp(join(base,prefix));return created;};
 return {createRoot};
}
