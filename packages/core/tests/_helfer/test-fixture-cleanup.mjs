import {mkdir, mkdtemp, rm, readdir, readFile} from 'node:fs/promises';
import {homedir} from 'node:os';
import {isAbsolute, join, relative, resolve, sep} from 'node:path';

export function createTestFixtureCleanup({
  rootDirectory = join(process.cwd(), 'coedit-test'),
  streamDirectory = join(homedir(), '.synapse', 'shell-streams'),
} = {}) {
  const rootBase = resolve(rootDirectory);
  const roots = new Set();
  const streamIds = new Set();
  let cleanupPromise, stopping=false, generation=0;
  const projects=new Set();
  const trackProject=project=>{if(typeof project!=='string'||!project||project.length>200)throw Error('Invalid test project');if(!projects.has(project)){projects.add(project);generation++;}};

  const trackRoot = root => {
    const fullPath = resolve(root);
    const inside = relative(rootBase, fullPath);
    if (!inside || inside === '..' || inside.startsWith('..' + sep) || isAbsolute(inside)) {
      throw new Error('Test fixture root must be a child of its dedicated root directory');
    }
    if(!roots.has(fullPath)){roots.add(fullPath);generation++;}
    return fullPath;
  };

  const trackStreamId = streamId => {
    if (typeof streamId !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(streamId)) {
      throw new Error('Invalid shell stream id');
    }
    if(!streamIds.has(streamId)){streamIds.add(streamId);generation++;}
  };

  const cleanup = () => {
    generation++;
    if (!cleanupPromise) {
      cleanupPromise = (async () => {
        let seen;
        do {
          seen=generation;
          if(projects.size){
            let names=[];try{names=await readdir(streamDirectory);}catch(e){if(e.code!=='ENOENT')throw e;}
            for(const name of names){
              const match=name.match(/^([a-zA-Z0-9_-]{1,128})\.meta\.json$/);if(!match)continue;
              let meta;try{meta=JSON.parse(await readFile(join(streamDirectory,name),'utf8'));}catch{/* Ungültige Metadaten sind kein Besitznachweis. */continue;}
              if(projects.has(meta.project))trackStreamId(match[1]);
            }
          }
          await Promise.all([...roots].map(root => rm(root, {recursive: true, force: true})));
          await Promise.all([...streamIds].flatMap(streamId => ['.log','.meta.json'].map(extension =>
            rm(join(streamDirectory, streamId + extension), {force: true}),
          )));
        }while(seen!==generation);
      })().finally(()=>{cleanupPromise=undefined;});
    }
    return cleanupPromise;
  };

  const onSignal = signal => {
    stopping=true;
    void cleanup().then(
      () => { process.exitCode = signal === 'SIGINT' ? 130 : 143; },
      error => {
        process.stderr.write('Test fixture cleanup failed: ' + error.message + '\n');
        process.exitCode = 1;
      },
    );
  };
  const onSigint = () => onSignal('SIGINT');
  const onSigterm = () => onSignal('SIGTERM');
  process.once('SIGINT', onSigint);
  process.once('SIGTERM', onSigterm);

  const createRoot = async prefix => {
    if (typeof prefix !== 'string' || !/^[a-zA-Z0-9._-]+-$/.test(prefix)) {
      throw new Error('Invalid test fixture prefix');
    }
    if(stopping)throw Error('Test fixture interrupted');
    await mkdir(rootBase, {recursive: true});
    const root=await mkdtemp(join(rootBase,prefix));
    if(stopping){await rm(root,{recursive:true,force:true});throw Error('Test fixture interrupted');}
    return trackRoot(root);
  };

  const dispose = () => {
    process.removeListener('SIGINT', onSigint);
    process.removeListener('SIGTERM', onSigterm);
  };

  return {createRoot, trackRoot, trackStreamId, trackProject, cleanup, dispose};
}

export function trackShellStreams(cleanup, execute) {
  return async options => {
    const onDetached = options.onDetached,onStarted=options.onStarted;
    const result = await execute({
      ...options,
      onStarted:started=>{cleanup.trackStreamId(started.stream_id);onStarted?.(started);},
      onDetached: detached => {
        cleanup.trackStreamId(detached.stream_id);
        onDetached?.(detached);
      },
    });
    if (result?.stream_id) cleanup.trackStreamId(result.stream_id);
    return result;
  };
}
