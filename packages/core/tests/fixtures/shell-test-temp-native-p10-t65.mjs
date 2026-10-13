/** Native-Probe-Fixture: Testdatei erzeugt ihren Root selbst, kein Test-Helfer. */
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
const root=await mkdtemp(join(tmpdir(),'t84-native-fixture-'));
await writeFile(join(root,'config.json'),'{}');
await rm(root,{recursive:true});
