/**
 * P22-T195 echte QuellenAnmerkungen/Lesefenster/AnmerkungSammelkorb im KI-Browser.
 * Private synapse_test:5433-PG/REST-Fixture, keine Inhaltsmocks; eigene isolierte Tabs.
 * User b48ad571: Ausschnitt/Quelle dauerhaft, Vorversion bleibt. Screenshots ui-screenshots/p22-t195.
 * Erwartet/ist und empfangener Wortlaut aus PG im Log; kein produktiver Empfänger/Agent.
 */
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {quellenanmerkungenFixture} from '../../rest-api/tests/quellenanmerkungen-fixture.mjs';
import {isolierterTab,evaluateWert} from '../../../scripts/lib/ki-browser-isolation.mjs';
import {screenshotAblage} from '../../../scripts/lib/ui-screenshots.mjs';
const repo=resolve(dirname(fileURLToPath(import.meta.url)),'../../..'),requireUi=createRequire(join(repo,'packages/web-ui/package.json'));
const {createServer}=await import(pathToFileURL(join(dirname(requireUi.resolve('vite/package.json')),'dist/node/index.js')).href);
const KB=process.env.SYNAPSE_KI_BROWSER_URL||'http://192.168.50.65:9222',HOST=process.env.SYNAPSE_UI_TEST_HOST||'192.168.50.10';
const kb=async(path,body)=>{const r=await fetch(KB+path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(20000)});const d=await r.json();assert.equal(d.success,true,JSON.stringify(d));return d.data;};
let f,vite,tab,checks=0,ablage;
const ev=async script=>evaluateWert(await kb('/evaluate',{tab_id:tab,script}));
const wait=async(script,label)=>{const end=Date.now()+20000;while(Date.now()<end){if(await ev('Boolean('+script+')')===true)return;await new Promise(r=>setTimeout(r,150));}throw Error('P22-T195 '+label+' erwartet=true ist='+await ev('document.body.innerText + JSON.stringify(window.__t195Fehler)'));};
const ok=(v,label,actual)=>{assert.ok(v,'P22-T195 QuellenAnmerkungen.tsx '+label+' erwartet=true ist='+JSON.stringify(actual??v));checks++;console.log('OK P22-T195 '+label);};
const click=script=>ev(script+'.click()');
const button=text=>"Array.from(document.querySelectorAll('button')).find(e=>e.textContent.trim()==="+JSON.stringify(text)+")";
const input=async(selector,value)=>ev("(()=>{const e=document.querySelector("+JSON.stringify(selector)+");Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(e,"+JSON.stringify(value)+");e.dispatchEvent(new Event('input',{bubbles:true}));})()");
const close=()=>click("document.querySelector('.verweis-fenster button[aria-label=\"Fenster schließen\"]')");
async function shot(name){if(!ablage||!tab)return;const r=await fetch(KB+'/screenshot?tab_id='+tab);assert.ok(r.ok);console.log('SCREENSHOT '+await ablage.speichere(name+'.png',Buffer.from(await r.arrayBuffer())));}
async function add(art,n){
 await click("document.querySelector('#quelle-"+art+" .verweis-link')");
 await wait("document.querySelector('.quellen-anmerkungen[data-anmerkungen-aktiv=\"1\"] .anmerkung-quelltext')?.innerText.includes('erste Zeile')",'Quelle '+art+' geladen');
 await ev("(()=>{const root=document.querySelector('.anmerkung-quelltext'),w=document.createTreeWalker(root,NodeFilter.SHOW_TEXT);let t;while(t=w.nextNode()){const i=t.textContent.indexOf('erste Zeile');if(i>=0){const r=document.createRange();r.setStart(t,i);r.setEnd(t,i+11);const s=window.getSelection();s.removeAllRanges();s.addRange(r);root.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:420,clientY:250}));return true;}}throw Error('P22-T195 Auswahl fehlt');})()");
 await wait("document.querySelector('.anmerkung-editor[role=\"menu\"]')",'Kontextmenü '+art);
 await click(button('Kommentieren'));await wait("document.querySelector('.anmerkung-editor textarea')",'Kommentar Editor');
 await input('.anmerkung-editor textarea','Browser '+art+' Kommentar '+n);await click(button('In Sammelkorb'));
 await wait("document.querySelector('.anmerkung-korb-knopf').textContent.includes('"+n+" Anmerkungen')",'Korb '+n);
 ok(await ev("!document.querySelector('.anmerkung-editor')"),'nur markierten Ausschnitt gesammelt '+art);
 await close();
}
try{
 f=await quellenanmerkungenFixture();
 for(const feature of ['zeilen_anmerkungen','chat_zitate','plattform_agent_chat'])
  await f.pool.query("INSERT INTO agent_profil_schalter(ebene,project,funktion,aktiv,grund,gesetzt_von) VALUES('projekt',$1,$2,true,'P22-T195 Browserfixture','user')",[f.P,feature]);
 vite=await createServer({root:join(repo,'packages/web-ui'),configFile:false,logLevel:'error',esbuild:{jsx:'automatic'},optimizeDeps:{entries:['tests/quellenanmerkungen.html']},server:{host:'0.0.0.0',port:0,proxy:{'/api':{target:f.url,headers:{authorization:'Bearer '+f.tokens.session}}}}});
 await vite.listen();ablage=await screenshotAblage(repo,'p22-t195');
 tab=(await isolierterTab(kb,{url:'http://'+HOST+':'+vite.httpServer.address().port+'/tests/quellenanmerkungen.html?project='+encodeURIComponent(f.P)+'&thought='+f.T})).tab_id;
 await wait("document.querySelector('#quelle-task .verweis-link')",'Testseite und echter Taskverweis');
 await add('task',1);await add('thought',2);await add('plan',3);
 await click("document.querySelector('.anmerkung-korb-knopf')");
 await wait("document.querySelectorAll('.anmerkung-korb article').length===3",'drei Quellen im Korb');
 ok(await ev("Array.from(document.querySelectorAll('.anmerkung-korb blockquote')).every(e=>e.textContent==='erste Zeile')"),'alle drei Ausschnitte exakt');
 await input('.anmerkung-korb article textarea','Browser Task KORRIGIERT');
 await shot('01-drei-quellen-bearbeitet');
 await click("document.querySelector('button[aria-label=\"Sammelkorb schließen\"]')");
 await click("document.querySelector('#seitenwechsel')");
 await click("document.querySelector('#seitenwechsel')");
 await click("document.querySelector('.anmerkung-korb-knopf')");
 await wait("document.querySelectorAll('.anmerkung-korb article').length===3",'Korb übersteht Seitenwechsel');
 ok(await ev("document.querySelector('.anmerkung-korb article textarea').value==='Browser Task KORRIGIERT'"),'bearbeiteter Kommentar übersteht Fenster-/Seitenwechsel');
 await click("document.querySelector('.anmerkung-korb input[role=\"combobox\"]')");
 await wait("document.querySelector('[data-empfaenger=\"gleicher-name\"]')",'Empfänger aus echter API');
 await click("document.querySelector('[data-empfaenger=\"gleicher-name\"]')");
 await wait("document.querySelector('.zitat-empfaenger-feld').dataset.zitatEmpfaengerAuswahl==='1'",'Empfänger gewählt');
 const before=Number((await f.pool.query('SELECT count(*) n FROM specialist_inbox')).rows[0].n);
 await click(button('Korb absenden'));
 await wait("document.querySelector('.anmerkung-korb [role=\"status\"]')?.textContent.includes('3 Anmerkungen dauerhaft')",'drei Kommentare gesendet');
 const rows=(await f.pool.query("SELECT id,content,to_identity_id FROM specialist_inbox WHERE from_agent='user' ORDER BY id")).rows;
 ok(rows.length===1&&rows[0].to_identity_id===f.A&&rows[0].content.includes('[Synapse-Zitate: 3]')&&rows[0].content.includes('Browser Task KORRIGIERT'),'eine tatsächliche Nachricht mit drei Zitaten',rows);
 ok(Number((await f.pool.query('SELECT count(*) n FROM specialist_inbox')).rows[0].n)===before+1,'genau eine Zustellung');
 ok(Number((await f.pool.query('SELECT count(*) n FROM quellenanmerkungen')).rows[0].n)===3,'alle Anmerkungen dauerhaft in PG');
 console.log('EMPFANG_WORTLAUT '+JSON.stringify(rows[0]));
 await shot('02-eine-nachricht-dauerhaft');
 await click("document.querySelector('button[aria-label=\"Sammelkorb schließen\"]')");
 // Separater Pin-Vorgang an Task, nachdem der erste Korb geleert ist.
 await add('task',1);await click("document.querySelector('.anmerkung-korb-knopf')");
 await wait("document.querySelectorAll('.anmerkung-korb article').length===1",'separater Pin-Korb');
 await click("document.querySelector('.anmerkung-korb .zitat-empfaenger-marke button')");
 ok(await ev("document.querySelector('.zitat-empfaenger-feld').dataset.zitatEmpfaengerAuswahl==='0'"),'Pin separat ohne Empfänger');
 await ev("(()=>{const label=Array.from(document.querySelectorAll('.anmerkung-korb label')).find(e=>e.textContent.includes('Ganzen Korb'));label.querySelector('input').click();})()");
 await wait("!"+button('Korb absenden')+".disabled",'Pin ohne Empfänger möglich');
 await click(button('Korb absenden'));
 await wait("document.querySelector('.anmerkung-korb [role=\"status\"]')?.textContent.includes('User-Entscheidung angepinnt')",'Pin bestätigt');
 const pins=(await f.pool.query("SELECT id,content,tags,task_id FROM thoughts WHERE source='user'")).rows;
 ok(pins.length===1&&pins[0].task_id==='P1-T1'&&pins[0].content.includes('Browser task Kommentar 1'),'echter Task-Pin',pins);
 await shot('03-user-entscheidung');
 await click("document.querySelector('button[aria-label=\"Sammelkorb schließen\"]')");
 await f.pool.query("UPDATE thoughts SET content='Gedanke überarbeitete Zeile\nGedanke zweite Zeile' WHERE id=$1",[f.T]);
 await click("document.querySelector('#quelle-thought .verweis-link')");
 await wait("document.querySelector('.quellen-anmerkungen-liste article')",'Quellenanmerkung wieder lesbar');
 await click(button('Vorversion vergleichen'));
 await wait("document.querySelector('.anmerkung-vergleich')?.innerText.includes('überarbeitete Zeile')",'Vor-/Nachversion geladen');
 ok(await ev("document.querySelector('.anmerkung-vergleich').innerText.includes('Gedanke erste Zeile')"),'Vorversion im echten Lesefenster erhalten');
 await shot('04-vorversion-vergleich');
 console.log('BESTANDEN '+checks+' P22-T195 KI-Browser/echte PG-Prüfungen');
}catch(e){await shot('99-fehler').catch(()=>{});throw e;}
finally{if(tab)await kb('/tabs/close',{tab_id:tab}).catch(()=>{});await vite?.close();await f?.close();}
