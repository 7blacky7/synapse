import {mkdir, mkdtemp, rm} from 'node:fs/promises';
import {homedir} from 'node:os';
import {isAbsolute, join, relative, resolve, sep} from 'node:path';

export function createTestFixtureCleanup({
  rootDirectory = join(process.cwd(), 'coedit-test'),
  streamDirectory = join(homedir(), '.synapse', 'shell-streams'),
} = {}) {
  const rootBase = resolve(rootDirectory);
  const roots = new Set();
  const streamIds = new Set();
  let cleanupPromise;

  const trackRoot = root => {
    const fullPath = resolve(root);
    const inside = relative(rootBase, fullPath);
    if (!inside || inside === '..' || inside.startsWith('..' + sep) || isAbsolute(inside)) {
      throw new Error('Test fixture root must be a child of its dedicated root directory');
    }
    roots.add(fullPath);
    return fullPath;
  };

  const trackStreamId = streamId => {
    if (typeof streamId !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(streamId)) {
      throw new Error('Invalid shell stream id');
    }
    streamIds.add(streamId);
  };

  const cleanup = () => {
    if (!cleanupPromise) {
      cleanupPromise = (async () => {
        await Promise.all([...roots].map(root => rm(root, {recursive: true, force: true})));
        await Promise.all([...streamIds].map(streamId =>
          rm(join(streamDirectory, streamId + '.log'), {force: true}),
        ));
      })();
    }
    return cleanupPromise;
  };

  const onSignal = signal => {
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
    await mkdir(rootBase, {recursive: true});
    return trackRoot(await mkdtemp(join(rootBase, prefix)));
  };

  const dispose = () => {
    process.removeListener('SIGINT', onSigint);
    process.removeListener('SIGTERM', onSigterm);
  };

  return {createRoot, trackRoot, trackStreamId, cleanup, dispose};
}

export function trackShellStreams(cleanup, execute) {
  return async options => {
    const onDetached = options.onDetached;
    const result = await execute({
      ...options,
      onDetached: detached => {
        cleanup.trackStreamId(detached.stream_id);
        onDetached?.(detached);
      },
    });
    if (result?.stream_id) cleanup.trackStreamId(result.stream_id);
    return result;
  };
}
