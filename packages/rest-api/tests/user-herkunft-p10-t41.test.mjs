import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
const u=new URL(process.env.DATABASE_URL||'http://ungueltig');
assert.equal(u.port,'5433');assert.equal(u.pathname,'/synapse_test');
const {getPool}=await import('../../core/dist/db/client.js');
const {darfKoordinatorOderUser}=await import('../../core/dist/services/rollen-pruefung.js');
const {postChannelMessage,getChannelMessages}=await import('../../core/dist/services/channels.js');
const {default:Fastify}=await import('fastify');
const {specialistRoutes}=await import('../dist/routes/specialists.js');
const {registerAuthHook}=await import('../dist/middleware/auth-hook.js');
const auth=await import('../dist/services/auth.js');
const {authRoutes}=await import('../dist/routes/auth.js');
const {mitUserHerkunft}=await import('../../core/dist/services/user-herkunft.js');
const pool=getPool(), project='sol3-t41-'+randomUUID(), tokens=[];
const app=Fastify();registerAuthHook(app);await app.register(specialistRoutes);await app.register(authRoutes);
const token=async(kind,scope)=>{const t=kind==='session'?await auth.issueSessionToken(scope):await auth.issueServiceToken(scope);tokens.push(t.token);return t.token;};
const post=(bearer,body={},route='user-post')=>app.inject({method:'POST',url:'/api/projects/'+project+'/channels/test/'+route,headers:{authorization:'Bearer '+bearer},payload:{content:'sol-3: Testnachricht',...body}});
try {
 await pool.query("INSERT INTO specialist_channels(name,project,created_by) VALUES('test',$1,'sol-3')",[project]);
 assert.equal(darfKoordinatorOderUser('koordinator'),true);
 assert.equal(darfKoordinatorOderUser('user'),false,'freier Name user ist kein Userausweis');
 const web=await token('session',null),tray=await token('session','ui:tray'),daemon=await token('service','daemon:tray');
 for(const bearer of [web,tray]) {
  const res=await post(bearer,{sender:'koordinator',agent_id:'user',herkunft:{kanal:'anders'}});
  assert.equal(res.statusCode,200,res.body);
 }
 const feed=await getChannelMessages(project,'test');
 assert.deepEqual(feed.map(m=>[m.sender,m.metadata?.herkunft]),[
  ['user',{akteur:'user',kanal:'web-ui-chat'}],['user',{akteur:'user',kanal:'tray'}]]);
 const foreign=await token('session','compute-node:test');
 assert.equal((await post(foreign)).statusCode,403);
 const access=await auth.issueAccessToken(null);tokens.push(access.token);
 assert.equal((await post(access.token)).statusCode,403);
 const expired=await auth.issueSessionToken('ui:tray',-1000);tokens.push(expired.token);
 assert.equal((await post(expired.token)).statusCode,401);
 const denied=await post(daemon);assert.equal(denied.statusCode,403,denied.body);
 const fake=await post(daemon,{sender:'user',metadata:{herkunft:{akteur:'user',kanal:'tray'}}},'post');
 assert.equal(fake.statusCode,200,fake.body);
 await postChannelMessage(project,'test','user','Gefälschter Metadatensatz',{herkunft:{akteur:'user',kanal:'tray'},sonst:'bleibt'});
 const all=await getChannelMessages(project,'test');
 assert.equal(all.at(-1).metadata?.herkunft,undefined);
 assert.equal(all.at(-1).metadata?.sonst,'bleibt');
 assert.equal(all.at(-2).metadata?.herkunft,undefined);
 const {baueChannelPush}=await import('../../agents/dist/channel-push.js');
 assert.equal(baueChannelPush([all[0]],{agentName:'sol-3'}).hatMensch,true);
 assert.match(baueChannelPush([all[1]],{agentName:'sol-3'}).text,/User \(Tray\)/);
 assert.equal(baueChannelPush([{id:999,channelName:'test',sender:'unbekannt',content:'sol-3: hallo'}],{agentName:'sol-3'}).hatMensch,false);
 const {ApiTransport}=await import('../../agents/dist/transport/api.js');
 assert.deepEqual(ApiTransport.alsChannelNachrichten(feed).map(m=>m.metadata),feed.map(m=>m.metadata));
 const contexts=await Promise.all([
  mitUserHerkunft('tray',async()=>{await Promise.resolve();return darfKoordinatorOderUser('USER');}),
  (async()=>{await Promise.resolve();return darfKoordinatorOderUser('user');})(),
 ]);
 assert.deepEqual(contexts,[true,false],'Userkontext bleibt auf eigenen Aufruf beschränkt');
 const login=await app.inject({method:'POST',url:'/api/auth/tray-session',headers:{authorization:'Bearer '+daemon},payload:{}});
 assert.equal(login.statusCode,401,'Daemon-Zugang kann keine Tray-Identität ausstellen');
 await auth.revokeToken(tray);
 assert.equal((await post(tray)).statusCode,401);
 process.env.SYNAPSE_AUTH_DISABLED='1';
 assert.equal((await post(daemon)).statusCode,403,'Bootstrap gewährt keine Userherkunft');
 delete process.env.SYNAPSE_AUTH_DISABLED;
 console.log('P10-T41 PASS: UI/Tray, Herkunft gespeichert, Agent/Spoof abgewiesen, Feed/Push, Widerruf/Bootstrap');
} finally {
 delete process.env.SYNAPSE_AUTH_DISABLED;
 for(const t of tokens)await auth.revokeToken(t);
 await pool.query('DELETE FROM specialist_channel_messages WHERE channel_id IN (SELECT id FROM specialist_channels WHERE project=$1)',[project]);
 await pool.query('DELETE FROM specialist_channels WHERE project=$1',[project]);
 await app.close();await pool.end();
}
