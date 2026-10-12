/** P9-T24: gezielte Fehler-/Signalprobe nach einer eigenen Fixture-Anlage. */
export async function fixtureCleanupCheckpoint(){
 if(process.env.SYNAPSE_FIXTURE_FAIL==='1')throw Error('P9_T24_EXPECTED_FAILURE');
 if(process.env.SYNAPSE_FIXTURE_WAIT_SIGNAL==='1'){
  const hold=setInterval(()=>{},1000);
  const wait=new Promise((_resolve,reject)=>{
   const stop=signal=>{clearInterval(hold);process.removeListener('SIGINT',onInt);process.removeListener('SIGTERM',onTerm);reject(Error('P9_T24_EXPECTED_SIGNAL '+signal));};
   const onInt=()=>stop('SIGINT'),onTerm=()=>stop('SIGTERM');
   process.once('SIGINT',onInt);process.once('SIGTERM',onTerm);
  });
  process.stderr.write('P9_T24_FIXTURE_READY\n');await wait;
 }
}
