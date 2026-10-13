import {createTestFixtureCleanup} from './shell-test-temp-helper-p10-t65.mjs';
import {writeFile,rm} from 'node:fs/promises';
const cleanup=createTestFixtureCleanup();
const root=await cleanup.createRoot('t84-native-fixture-');
await writeFile(root+'/config.json','{}');
await rm(root,{recursive:true});
