#!/usr/bin/env node
/**
 * P18-T97 F3 tranche 1. Coordinator maintenance after review + full backup.
 * Default dry-run: READ ONLY, streaming canonical JSONL manifest, no cache/share work.
 * --tranche 1 (default, unchanged) | 2a (1550 explicitly approved source IDs).
 * Tranche 2b CACHE IS NOT IMPLEMENTED: no cache writes bypass the existing TX guard.
 * --eintrag rev-die-siedler-3-229a52 [--manifest <NEW local audit-data.jsonl>]
 * Apply: --ausfuehren --manifest <sealed audit-data.jsonl>
 * --manifest-sha256 <sha256> --backup-beleg <verified backup identifier>
 * Apply optional --vollsentinel-alle-batches N (default 0, bounded by actual batch count).
 * Optional --sentinel-timeout-ms is bounded by the PG catalog and pinned in manifest/journal.
 * DATABASE_URL comes from the authorised SERVER maintenance environment.
 * Schema145 is deployed normally; this script NEVER creates schema/tables.
 * Import has no I/O side effect. Tests run only when the coordinator opens test phase.
 */
import {createHash} from 'node:crypto';
import {AsyncLocalStorage} from 'node:async_hooks';
import {constants} from 'node:fs';
import {open,realpath} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
import {leseReverseEinstellwerte,reverseZahl,REVERSE_EINSTELLKATALOG} from '@synapse/core';
import {leseReversePipelineHalt} from '../../core/dist/services/reverse-pipeline-halt.js';

export const ENTRY='rev-die-siedler-3-229a52';
export const FORMATS=['png','gif','wav','jpeg','avi','ico','zip'];
// Coordinator-approved tranche2a snapshot (aeaa8611): exactly 1550 source IDs.
// This is NOT a blanket 'unknown format' rule; the generated manifest pins each
// complete source/code row and must be reviewed before apply.
export const TRANCHE_2A_SOURCE_IDS=Object.freeze([
 '5','16','17','18','19','20','22','23','24','77','78','79','80','81','88','89','90','91','92','93','94','95','96','97',
 '98','99','100','101','102','103','104','105','106','107','108','109','110','111','136','144','145','146','147','149','150','151','172','173',
 '174','175','176','177','178','182','183','184','185','186','187','188','191','194','195','196','198','199','200','201','202','203','204','205',
 '206','207','208','209','210','211','212','213','214','215','216','217','218','219','220','221','246','247','248','249','250','251','252','253',
 '254','255','256','257','258','259','260','261','262','263','264','265','266','267','268','269','467','468','469','470','471','472','473','474',
 '476','481','491','492','493','495','496','498','529','640','647','648','649','650','651','652','653','654','655','656','657','658','659','660',
 '661','662','663','665','672','677','679','680','681','682','683','693','694','695','696','697','698','699','700','701','702','703','704','705',
 '706','707','708','709','710','711','712','713','714','716','726','727','728','729','730','731','732','733','734','735','736','737','738','739',
 '740','741','742','743','744','745','746','747','748','749','750','751','752','753','754','755','756','757','758','759','760','761','762','763',
 '764','765','766','767','768','769','770','772','773','774','775','776','777','778','779','780','781','782','783','784','785','786','787','788',
 '789','790','791','792','793','794','795','796','797','798','799','800','801','805','808','1194','1195','1196','1197','1198','1199','1200','1206','1207',
 '1208','1211','1212','1262','1263','1264','1265','1266','1267','1268','1269','1270','1271','1272','1273','1274','1275','1276','1277','1278','1279','1280','1281','1282',
 '1283','1284','1285','1286','1287','1288','1289','1290','1291','1292','1293','1294','1295','1296','1297','1298','1299','1300','1301','1302','1303','1304','1305','1306',
 '1307','1308','1309','1310','1313','1314','1320','1321','1322','1323','1324','1331','1332','1333','1334','1335','1336','1352','1354','1355','1356','1665','1666','1667',
 '1668','1669','1670','1671','1672','1681','1682','1683','1684','1685','1686','1687','1688','1697','1698','1699','1700','1701','1702','1703','1704','1705','1706','1707',
 '1708','1709','1710','1711','1712','1748','1792','1793','1794','1795','1796','1797','1798','1799','1800','1801','1802','1803','1804','1805','1806','1807','1808','1809',
 '1810','1811','1812','1813','1814','1815','1816','1817','1818','1819','1820','1821','1822','1823','1824','1825','1826','1827','1828','1829','1830','1831','1832','1833',
 '1834','1835','1836','1837','1838','1839','1840','1841','1842','1843','1844','1845','1846','1847','1848','1849','1850','1851','1852','1853','1854','1855','1856','1857',
 '1858','1859','1860','1861','1862','1863','1864','1865','1866','1867','1868','1869','1870','1871','1872','1873','1874','1875','1876','1877','1878','1879','1880','1881',
 '1882','1883','1884','1885','1886','1887','1888','1889','1890','1891','1892','1893','1894','1895','1896','1897','1898','1899','1900','1901','1902','1903','1904','1905',
 '1906','1907','1908','1909','1910','1911','1912','1913','1914','1915','1916','1917','1918','1919','1920','1921','1922','1923','1924','1925','1926','1927','1928','1929',
 '1930','1931','1932','1933','1934','1935','1936','1937','1938','1939','1940','1941','1942','1943','1944','1945','1946','1947','1948','1949','1950','1951','1952','1953',
 '1954','1955','1956','1957','1958','1959','1960','1961','1962','1963','1964','1965','1966','1967','1968','1970','1971','1972','1973','1974','1975','1976','1977','1978',
 '1979','1980','1981','1982','1983','1984','1991','1992','1996','1998','2001','2008','2012','2016','2017','2018','2019','2020','2021','2022','2023','2024','2025','2026',
 '2027','2028','2029','2030','2031','2033','2035','2043','2047','2048','2055','2058','2061','2062','2065','2066','2067','2068','2069','2070','2071','2073','2074','2075',
 '2076','2077','2078','2079','2080','2081','2084','2088','2089','2093','2098','2114','2119','2123','2124','2125','2127','4202','4203','4204','4205','4206','4207','4208',
 '4209','4210','4211','4212','4213','4219','4220','4221','4222','4223','4242','4243','4244','4245','4246','4247','4248','4249','4250','4251','4252','4253','4266','4267',
 '4268','4269','4270','4271','4272','4273','4274','4275','4276','4277','4338','4339','4340','4341','4342','4343','4344','4345','4346','4347','4348','4349','4402','4403',
 '4404','4405','4406','4407','4408','4409','4410','4411','4412','4413','4414','4415','4416','4417','4418','4419','4420','4421','4422','4423','4424','4425','4426','4427',
 '4428','4429','4430','4431','4432','4433','4434','4435','4436','4437','4438','4439','4440','4441','4442','4443','4444','4445','4446','4447','4448','4449','4450','4451',
 '4452','4453','4454','4455','4456','4457','4458','4459','4460','4461','4462','4463','4464','4465','4466','4467','4468','4469','4470','4471','4472','4473','4474','4475',
 '4476','4477','4478','4479','4480','4481','4482','4483','4484','4485','4486','4487','4488','4489','4490','4491','4492','4493','4494','4495','4496','4497','4498','4499',
 '4500','4501','4502','4503','4504','4505','4506','4507','4508','4509','4510','4511','4512','4513','4514','4515','4516','4517','4518','4519','4520','4521','4522','4523',
 '4524','4525','4526','4527','4528','4529','4530','4531','4532','4533','4534','4535','4536','4537','4538','4539','4540','4541','4542','4543','4544','4545','4546','4547',
 '4548','4549','4550','4551','4552','4553','4554','4555','4556','4557','4558','4559','4560','4561','4562','4563','4564','4565','4566','4567','4568','4569','4570','4571',
 '4572','4573','4574','4575','4576','4577','4578','4579','4580','4581','4582','4583','4584','4585','4586','4587','4588','4589','4590','4591','4592','4593','4594','4595',
 '4596','4597','4598','4599','4600','4601','4602','4603','4604','4605','4606','4607','4608','4609','4610','4611','4612','4613','4614','4615','4616','4617','4618','4619',
 '4620','4621','4622','4623','4624','4625','4626','4627','4628','4629','4630','4631','4632','4633','4634','4635','4636','4637','4638','4639','4640','4641','4642','4643',
 '4644','4645','4646','4647','4648','4649','4650','4651','4652','4653','4654','4655','4656','4657','4658','4659','4660','4661','4662','4663','4664','4665','4666','4667',
 '4668','4669','4670','4671','4672','4673','4674','4675','4676','4677','4678','4679','4680','4681','4682','4683','4684','4685','4686','4687','4688','4689','4690','4691',
 '4692','4693','4694','4695','4696','4697','4699','4700','4701','4702','4703','4704','4705','4706','4707','4708','4709','4710','4711','4712','4713','4714','4715','4716',
 '4717','4718','4719','4720','4721','4722','4723','4724','4725','4726','4727','4728','4729','4730','4731','4732','4733','4734','4735','4736','4737','4738','4739','4740',
 '4741','4742','4743','4744','4745','4746','4747','4748','4749','4750','4751','4752','4753','4754','4755','4756','4757','4758','4759','4760','4761','4762','4763','4764',
 '4765','4766','4767','4768','4769','4770','4771','4772','4773','4774','4775','4776','4777','4778','4779','4780','4781','4782','4783','4784','4785','4786','4787','4788',
 '4789','4790','4791','4792','4793','4794','4795','4796','4797','4798','4799','4800','4801','4802','4803','4804','4805','4806','4807','4808','4809','4810','4811','4812',
 '4813','4814','4815','4816','4817','4818','4819','4820','4821','4822','4823','4824','4825','4826','4827','4828','4829','4830','4831','4832','4833','4834','4835','4836',
 '4837','4847','4849','4851','4853','4855','4858','4871','4878','4880','4883','4885','4887','4891','4893','4897','4903','4905','4907','4920','4922','4930','4935','4938',
 '4942','4944','4950','4966','4993','4995','4998','5000','5002','5005','5009','5022','5025','5031','5034','5037','5043','5050','5058','5064','5084','5088','5092','5093',
 '5094','5095','5096','5097','5098','5099','5100','5101','5102','5103','5104','5105','5106','5107','5108','5109','5110','5111','5112','5113','5114','5115','5116','5117',
 '5118','5273','5274','5275','5276','5277','5278','5279','5280','5281','5282','5283','5284','5285','5286','5287','5288','5289','5290','5291','5292','5293','5294','5295',
 '5296','5297','5298','5299','5300','5301','5302','5303','5304','5305','5306','5307','5308','5309','5310','5311','5312','5313','5314','5315','5316','5317','5318','5319',
 '5320','5321','5322','5323','5324','5325','5326','5327','5328','5329','5330','5331','5332','5333','5334','5335','5336','5337','5338','5339','5340','5341','5342','5343',
 '5344','5345','5346','5347','5348','5349','5350','5351','5352','5353','5354','5355','5356','5357','5358','5359','5360','5361','5362','5363','5364','5365','5366','5367',
 '5368','5369','5370','5371','5372','5373','5374','5375','5376','5377','5378','5379','5380','5381','5382','5383','5384','5385','5386','5387','5388','5389','5390','5391',
 '5392','5393','5394','5395','5396','5397','5398','5399','5400','5401','5402','5403','5404','5405','5406','5407','5408','5409','5410','5411','5412','5413','5414','5415',
 '5416','5417','5418','5419','5420','5421','5422','5423','5424','5425','5426','5427','5428','5429','5430','5431','5432','5433','5434','5435','5436','5437','5438','5439',
 '5440','5441','5442','5443','5444','5445','5446','5447','5448','5449','5450','5451','5452','5453','5454','5455','5456','5457','5458','5459','5460','5461','5462','5463',
 '5464','5465','5466','5467','5468','5469','5470','5471','5472','5473','5474','5475','5476','5477','5478','5479','5480','5481','5482','5483','5484','5485','5486','5487',
 '5488','5489','5490','5491','5492','5493','5494','5495','5496','5497','5498','5499','5500','5501','5502','5503','5504','5505','5506','5507','5508','5509','5510','5511',
 '5512','5513','5514','5515','5516','5517','5518','5519','5520','5521','5522','5523','5524','5525','5526','5527','5528','5529','5530','5531','5532','5533','5534','5535',
 '5536','5537','5538','5539','5540','5541','5542','5543','5544','5545','5546','5547','5548','5549','5550','5551','5552','5553','5554','5555','5556','5557','5558','5559',
 '5560','5561','5562','5563','5564','5565','5566','5567','5568','5569','5570','5571','5572','5573','5574','5575','5576','5577','5578','5579','5580','5581','5582','5583',
 '5584','5585','5586','5587','5588','5589','5590','5591','5592','5593','5594','5595','5596','5597','5598','5599','5600','5601','5602','5603','5604','5605','5606','5607',
 '5608','5609','5610','5611','5612','5613','5614','5615','5616','5617','5618','5619','6010','6011','6012','6400','6401','6402','6599','6600','6601','6602','6603','7052',
 '7053','7054','7103','7104','7105','7106','7107','7108','8539','8540','8541','8542','8543','8544'
]);
const TRANCHE_2A_SOURCES=new Set(TRANCHE_2A_SOURCE_IDS);
const TRANCHE_2A_EXTRA_PARTS=new Set(['762','8542']);
const TRANCHE_2A_EXTENSIONS=Object.freeze(['bin','map','txt','bmp','gif','dat','json','inf','ico','hlp','cur','chm','ini','ani','cnf','cab','url','btr','pdf','iso','ex_','edm','ins','dls','lck','lid','psd','shl','tag','tif','uif','gfx']);
const TRANCHES=new Set(['1','2a']);
const trancheScope=t=>'p18-t97-f3-tranche'+t;
function trancheValue(t){if(!TRANCHES.has(t))stop('f3_parameter');return t;}
function headerTranche(h){return h.scope===trancheScope('2a')?'2a':'1';}
function qualification(){return {quellen:TRANCHE_2A_SOURCE_IDS.length,quellen_sha256:hash(TRANCHE_2A_SOURCE_IDS),zweitteile:['762','8542'],endungen:[...TRANCHE_2A_EXTENSIONS]};}
function formatsFor(t){return t==='2a'?['unbekannt','pdf']:FORMATS;}
function eligibleFor(t){
 if(t==='1')return eligible;
 if(t!=='2a')stop('f3_parameter');
 // All literals are fixed numeric IDs / fixed alphanumeric suffixes, never CLI SQL.
 return eligible+" AND d.id=ANY(ARRAY["+TRANCHE_2A_SOURCE_IDS.join(',')+"]::bigint[])"+
  " AND lower(substring(d.pfad from '[.]([^./]+)$'))=ANY(ARRAY["+TRANCHE_2A_EXTENSIONS.map(x=>"'"+x+"'").join(',')+"]::text[])"+
  " AND (c.file_name IN ('strings.txt','imports.txt') OR (c.file_name='strings-0002.txt' AND d.id IN (762,8542)))";
}
function validTrancheFile(f,t){
 return t==='1'||TRANCHE_2A_SOURCES.has(f.source_id)&&
  (f.name==='strings.txt'||f.name==='imports.txt'||f.name==='strings-0002.txt'&&TRANCHE_2A_EXTRA_PARTS.has(f.source_id));
}

export function canon(x){return JSON.stringify(order(x));}
function order(x){return Array.isArray(x)?x.map(order):x&&typeof x==='object'?Object.fromEntries(Object.keys(x).sort().map(k=>[k,order(x[k])])):x;}
export const sha=x=>createHash('sha256').update(x).digest('hex');
const hash=x=>sha(canon(x)),size=x=>Buffer.byteLength(canon(x));
const stop=code=>{throw Error(code);};
const same=(a,b,code)=>{if(canon(a)!==canon(b))stop(code);};
const ident=x=>'"'+String(x).replaceAll('"','""')+'"';
const validHash=x=>typeof x==='string'&&/^[a-f0-9]{64}$/.test(x);
export const validName=x=>typeof x==='string'&&(/^(?:strings(?:-[0-9]+)?[.]txt)$/.test(x)||x==='imports.txt');
// PostgreSQL COLLATE "C" on UTF8 and the manifest reader must compare the
// SAME bytes, independently of database locale and JavaScript UTF16 ordering.
const compareIds=(a,b)=>Buffer.compare(Buffer.from(a,'utf8'),Buffer.from(b,'utf8'));

const contexts=new AsyncLocalStorage(),failures=new WeakMap(),lockFailures=new WeakMap();
const F3_CODES=new Set(["f3_abhaengigkeit_stop","f3_belegpfad_verboten","f3_bereinigung_laeuft","f3_dateiname","f3_datenbank_fehlt","f3_einstellungen_geaendert","f3_eintrag_nicht_freigegeben","f3_einzelzeile_ueber_budget","f3_fk_unbekannt","f3_halt_erforderlich","f3_journal_daten_widerspruch","f3_katalog_geaendert","f3_journal_konflikt","f3_journal_nebenwirkung","f3_loeschmenge_geaendert","f3_manifest_batch_geaendert","f3_manifest_budget","f3_manifest_fehlt","f3_manifest_fragment","f3_manifest_geaendert","f3_manifest_hash","f3_manifest_header","f3_manifest_json","f3_manifest_nicht_kanonisch","f3_manifest_metadaten","f3_manifest_metadaten_geaendert","f3_manifest_nicht_versiegelt","f3_manifest_op","f3_manifest_quellkonflikt","f3_manifest_record_zu_gross","f3_manifest_reihenfolge","f3_nicht_ruhig","f3_parameter","f3_projektbestand_geaendert","f3_projekttabelle_unzugeordnet","f3_projektzeile_unzugeordnet","f3_quelle_geaendert","f3_relation_unbekannt","f3_schema145_abweichend","f3_schema145_fehlt","f3_sentinel_budget","f3_sentinel_im_manifest_gepinnt","f3_sicherungsbeleg_fehlt","f3_symbol_geaendert","f3_trigger_unbekannt","f3_tx_budget","f3_tx_fremdmutation","f3_tx_delta_abweichung","f3_tx_lock_unerlaubt","f3_regel_unbekannt","f3_rls_unbekannt","f3_batch_verbindung_fehlt","f3_werkzeug_fehler","f3_zwischen_budget"]);
const PHASES=new Set(['initialisieren','audit_open','db_connect','db_begin','einstellungen','timeouts','fk_katalog','ruhe','journal','sentinel_katalog','sentinel_ownership','sentinel_count','sentinel_hash','sentinel_restore','kandidaten','symbole','abhaengigkeiten','manifest_header','manifest_metadaten','manifest_records','manifest_sync','manifest_pruefen','endbilanz','tx_schutz','tx_baseline','tx_locks','apply','commit','abschluss']);
const TABLES=new Set(['asset_aenderungen','asset_aenderungsstaende','asset_files','asset_host_checkpoints','asset_inspektions_auftraege','asset_inspektions_projekte','asset_konflikt_eingaenge','asset_konflikt_loesungen','asset_konflikte','asset_manifest_eintraege','asset_manifest_sitzungen','asset_mutationen','asset_objects','asset_projekt_optionen','asset_references','asset_retention_referenzen','asset_revisionen','asset_scan_checkpoints','asset_upload_sitzungen','asset_upload_teile','code_call_edges','code_chunks','code_files','code_references','code_statements','code_symbols','file_versions']);
const FS_CODES=new Set(['EACCES','EPERM','ENOENT','EEXIST','ENOSPC','EROFS','EIO','ELOOP','EMFILE','ENFILE','EISDIR','ENOTDIR']);
function phase(name,table){const c=contexts.getStore();if(c){c.phase=PHASES.has(name)?name:'initialisieren';c.table=TABLES.has(table)?table:undefined;}}
function capture(e,source){
 const c=contexts.getStore();if(!c||c.first)return;
 c.error=e;c.first={code:F3_CODES.has(e?.message)?e.message:'f3_werkzeug_fehler',phase:c.phase??'initialisieren',
  ...(c.table?{tabelle:c.table}:{}),...(source==='pg'&&/^[0-9A-Z]{5}$/.test(e?.code)?{pg_code:e.code}:{}),
  ...(FS_CODES.has(e?.code)?{fs_code:e.code}:{}),...(lockFailures.has(e)?{lock:lockFailures.get(e)}:{})};
}
async function diagnosed(fn){
 if(contexts.getStore())return fn();
 return contexts.run({phase:'initialisieren'},async()=>{try{return await fn();}catch(e){capture(e);if(e&&typeof e==='object')failures.set(e,{...contexts.getStore().first,committed_batches:contexts.getStore().error?.committed_batches??0,resumed_batches:contexts.getStore().error?.resumed_batches??0,...(contexts.getStore().error?.alarm===true?{alarm:true}:{})});throw e;}});
}
function observed(db){
 return {...(db.options?{options:db.options}:{}),...(db.connectFresh?{connectFresh:async()=>observed(await db.connectFresh())}:{}),query:async(...args)=>{try{return await db.query(...args);}catch(e){capture(e,'pg');throw e;}},
  ...(db.connect?{connect:async()=>{try{return observed(await db.connect());}catch(e){capture(e,'pg');throw e;}}}:{}),
  ...(db.release?{release:(...args)=>db.release(...args)}:{}),...(db.end?{end:()=>db.end()}:{} )};
}
export function failureDiagnostic(e){const d=failures.get(e);return {status:'gestoppt',...(d??{code:F3_CODES.has(e?.message)?e.message:'f3_werkzeug_fehler',phase:'initialisieren'}),
 committed_batches:d?.committed_batches??e?.committed_batches??0,resumed_batches:d?.resumed_batches??e?.resumed_batches??0};}
export function sentinelPolicy(settings,override){
 const max=Number(REVERSE_EINSTELLKATALOG.leser_statement_timeout_ms.max);
 const timeout=override??settings.statement;
 if(!Number.isSafeInteger(timeout)||timeout<1||timeout>max)stop('f3_sentinel_budget');
 return {timeout_ms:timeout,quelle:override===undefined?'pg':'cli'};
}

const eligible=[
 "c.eintrag_id=$1 AND c.schicht='S1' AND c.parser_generation_id IS NULL AND c.deleted_at IS NULL",
 "AND d.format=ANY($2::text[]) AND d.sha256 IS NOT NULL AND d.storage_key IS NOT NULL",
 "AND NOT (COALESCE(d.metadaten#>>'{code_klassifikation,ist_code}','false')='true' AND d.metadaten#>>'{code_klassifikation,sha256}'=d.sha256)",
 "AND (c.file_name ~ '^strings(-[0-9]+)?[.]txt$' OR (c.file_name='imports.txt' AND COALESCE(c.content,'')=''))"
].join(' ');
const cols="c.id,c.file_path,c.file_name,c.datei_id::text AS source_id,d.sha256 AS source_sha,to_jsonb(c)::text AS raw,to_jsonb(d)::text AS source_raw";
const FK=new Set([
 'reverse_code_symbole>reverse_code_dateien:FOREIGN KEY (eintrag_id, file_path) REFERENCES reverse_code_dateien(eintrag_id, file_path) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED',
 'reverse_code_symbole>reverse_code_symbole:FOREIGN KEY (parent_symbol) REFERENCES reverse_code_symbole(id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED',
 'reverse_code_verweise>reverse_code_dateien:FOREIGN KEY (eintrag_id, file_path) REFERENCES reverse_code_dateien(eintrag_id, file_path) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED',
 'reverse_code_verweise>reverse_code_symbole:FOREIGN KEY (symbol_id) REFERENCES reverse_code_symbole(id) ON DELETE CASCADE',
 'reverse_code_statements>reverse_code_dateien:FOREIGN KEY (eintrag_id, file_path) REFERENCES reverse_code_dateien(eintrag_id, file_path) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED',
 'reverse_code_kanten>reverse_code_dateien:FOREIGN KEY (eintrag_id, file_path) REFERENCES reverse_code_dateien(eintrag_id, file_path) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED',
 'reverse_code_kanten>reverse_code_symbole:FOREIGN KEY (target_symbol_id) REFERENCES reverse_code_symbole(id) ON DELETE SET NULL'
]);
const CODE_TABLES=['reverse_code_dateien','reverse_code_symbole','reverse_code_verweise','reverse_code_statements','reverse_code_kanten'];
async function schemaEvidence(db){
 phase('fk_katalog');
 // Resolve the SAME exact schema/OIDs used by our locks and dependency queries.
 const relations=(await db.query("SELECT c.relname AS name,c.oid::text AS oid,n.nspname AS schema,to_regclass(quote_ident(c.relname))::oid::text AS visible_oid FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=current_schema() AND c.relname=ANY($1::text[]) AND c.relkind='r'",[CODE_TABLES])).rows;
 if(relations.length!==CODE_TABLES.length||relations.some(r=>r.oid!==r.visible_oid))stop('f3_relation_unbekannt');
 const by=new Map(relations.map(r=>[r.name,r])),targets=['reverse_code_dateien','reverse_code_symbole'].map(n=>by.get(n).oid);
 // Do NOT filter child schemas: every incoming FK from the entire DB is inspected.
 const r=await db.query("SELECT k.oid::text AS constraint_oid,k.convalidated,k.conrelid::text AS child_oid,k.confrelid::text AS parent_oid,c.relname AS t,p.relname AS target,cn.nspname AS child_schema,pn.nspname AS parent_schema,pg_get_constraintdef(k.oid) AS def FROM pg_constraint k JOIN pg_class c ON c.oid=k.conrelid JOIN pg_namespace cn ON cn.oid=c.relnamespace JOIN pg_class p ON p.oid=k.confrelid JOIN pg_namespace pn ON pn.oid=p.relnamespace WHERE k.contype='f' AND k.confrelid=ANY($1::oid[])",[targets]);
 for(const f of r.rows){
  const child=by.get(f.t),parent=by.get(f.target);
  if(!child||!parent||f.child_oid!==child.oid||f.parent_oid!==parent.oid||
     f.child_schema!==child.schema||f.parent_schema!==parent.schema||
     !FK.has(f.t+'>'+f.target+':'+f.def))stop('f3_fk_unbekannt');
 }
 const allRelations=relations.map(r=>r.oid);
 const triggers=await db.query("SELECT oid::text AS trigger_oid,tgrelid::text AS relation_oid,tgname,tgenabled,tgisinternal,tgfoid::text AS function_oid,tgconstraint::text AS constraint_oid,tgtype,tgattr::text AS attributes,encode(tgargs,'hex') AS args,pg_get_triggerdef(oid) AS def FROM pg_trigger WHERE tgrelid=ANY($1::oid[])",[allRelations]);
 if(triggers.rows.some(t=>!t.tgisinternal&&targets.includes(t.relation_oid)))stop('f3_trigger_unbekannt');
 return {write_surface:await writeSurface(db),relations:[...relations].sort((a,b)=>a.name<b.name?-1:a.name>b.name?1:0),
  foreign_keys:[...r.rows].sort((a,b)=>a.constraint_oid<b.constraint_oid?-1:a.constraint_oid>b.constraint_oid?1:0),
  triggers:[...triggers.rows].sort((a,b)=>a.trigger_oid<b.trigger_oid?-1:a.trigger_oid>b.trigger_oid?1:0)};
}
export async function schemaGuard(db){return hash(await schemaEvidence(db));}
async function checkCatalog(db,h){
 const evidence=await schemaEvidence(db);
 same(hash(evidence),h.katalog_sha256,'f3_katalog_geaendert');
 return evidence.write_surface;
}
async function settings(db){
 phase('einstellungen');
 const s=await leseReverseEinstellwerte({eintrag_id:ENTRY},db);
 if(s.letzter_fehler)stop(s.letzter_fehler);
 return {revision:s.revision,rows:reverseZahl(s,'e_uebernahme_block_zeilen'),maxBytes:reverseZahl(s,'materialisierung_tx_bytes'),
  recordBytes:reverseZahl(s,'manifest_record_bytes'),statement:reverseZahl(s,'leser_statement_timeout_ms'),lock:reverseZahl(s,'leser_lock_timeout_ms')};
}
const TERMINAL_JOBS=['completed','failed','cancelled','expired'];
async function quiet(db){
 phase('ruhe');
 const h=await leseReversePipelineHalt(db);if(!h.aktiv||h.letzter_fehler)stop('f3_halt_erforderlich');
 if((await db.query("SELECT 1 FROM reverse_auftraege WHERE status IN('offen','wartet','laeuft') OR lease_bis>clock_timestamp() LIMIT 1")).rows.length)stop('f3_nicht_ruhig');
 // Terminal historical P20 flags alone are NOT evidence of a living resource.
 // Any non-terminal job, live lease or non-done run (including older attempts)
 // remains a hard stop, independently of resource_unconfirmed.
 if((await db.query("SELECT 1 FROM work_jobs w WHERE w.scope='reverse' AND (w.state IS NULL OR NOT (w.state=ANY($1::text[])) OR w.lease_until>clock_timestamp()) LIMIT 1",[TERMINAL_JOBS])).rows.length)stop('f3_nicht_ruhig');
 if((await db.query("SELECT 1 FROM tool_container_runs r JOIN work_jobs w ON w.id=r.job_id WHERE w.scope='reverse' AND r.state IS DISTINCT FROM 'done' LIMIT 1")).rows.length)stop('f3_nicht_ruhig');
 const stale=(await db.query("SELECT id::text AS job_id,state,attempt FROM work_jobs WHERE scope='reverse' AND state=ANY($1::text[]) AND resource_unconfirmed ORDER BY id",[TERMINAL_JOBS])).rows;
 return stale.map(r=>({code:'f3_terminaler_altmarker',job_id:r.job_id,state:r.state,attempt:r.attempt}));
}
const indirect={
 asset_revisionen:{owner:"a.project",join:"JOIN asset_files a ON a.id=t.asset_id",valid:"EXISTS(SELECT 1 FROM asset_files a WHERE a.id=t.asset_id)"},
 asset_konflikte:{owner:"a.project",join:"JOIN asset_files a ON a.id=t.asset_id",valid:"EXISTS(SELECT 1 FROM asset_files a WHERE a.id=t.asset_id)"},
 asset_retention_referenzen:{owner:"a.project",join:"JOIN asset_files a ON a.id=t.asset_id",valid:"EXISTS(SELECT 1 FROM asset_files a WHERE a.id=t.asset_id)"},
 asset_manifest_eintraege:{owner:"m.project",join:"JOIN asset_manifest_sitzungen m ON m.id=t.manifest_id",valid:"EXISTS(SELECT 1 FROM asset_manifest_sitzungen m JOIN asset_files a ON a.id=t.asset_id AND a.project=m.project WHERE m.id=t.manifest_id)"},
 // Root-key protocol is defined by share-scanner.ts:89; include every checkpoint
 // conservatively (also Reverse roots), rather than lose an unassignable owner.
 asset_scan_checkpoints:{owner:"'root:'||t.root_key",join:"",valid:"t.root_key LIKE 'projekt:%' OR t.root_key LIKE 'reverse:%'"},
 asset_upload_sitzungen:{owner:"CASE WHEN t.bereich='projekt' THEN t.ziel_ref ELSE '@reverse-transport:'||t.ziel_ref END",join:"",valid:"t.bereich IN('projekt','reverse') AND t.ziel_ref IS NOT NULL"},
 asset_upload_teile:{owner:"CASE WHEN u.bereich='projekt' THEN u.ziel_ref ELSE '@reverse-transport:'||u.ziel_ref END",join:"JOIN asset_upload_sitzungen u ON u.id=t.upload_id",valid:"EXISTS(SELECT 1 FROM asset_upload_sitzungen u WHERE u.id=t.upload_id AND u.bereich IN('projekt','reverse') AND u.ziel_ref IS NOT NULL)"}
};
/** Counts AND SHA256 of complete canonical records (IDs/revisions/content included).
 * Caller supplies a consistent read-only snapshot (manifest or informational pass).
 * All projects and indirect owners; unknown ownership invalidates the snapshot.
 */
export async function projectSentinel(db,policy){
 phase('sentinel_katalog');
 const old=policy?(await db.query("SELECT current_setting('statement_timeout') AS v")).rows[0].v:null;
 if(policy)await db.query("SELECT set_config('statement_timeout',$1,false)",[String(policy.timeout_ms)]);
 let primary=false;
 try{
 const schema=(await db.query('SELECT current_schema() AS s')).rows[0].s;
 const names=(await db.query("SELECT t.table_name,EXISTS(SELECT 1 FROM information_schema.columns c WHERE c.table_schema=t.table_schema AND c.table_name=t.table_name AND c.column_name='project') AS direct FROM information_schema.tables t WHERE t.table_schema=$1 AND t.table_type='BASE TABLE' AND (t.table_name LIKE 'asset\\_%' ESCAPE '\\' OR t.table_name LIKE 'code\\_%' ESCAPE '\\' OR t.table_name='file_versions') ORDER BY t.table_name",[schema])).rows;
 const out={};
 for(const {table_name:t,direct} of names){
  phase('sentinel_ownership',t);
  const spec=direct?{owner:'t.project',join:'',valid:'t.project IS NOT NULL'}:indirect[t];
  if(!spec)stop('f3_projekttabelle_unzugeordnet');
  const table=ident(schema)+'.'+ident(t);
  phase('sentinel_ownership',t);
  if((await db.query('SELECT 1 FROM '+table+' t WHERE ('+spec.valid+') IS NOT TRUE LIMIT 1')).rows.length)stop('f3_projektzeile_unzugeordnet');
  phase('sentinel_count',t);
  const counts=(await db.query('SELECT '+spec.owner+'::text AS owner,count(*)::text AS n FROM '+table+' t '+spec.join+' GROUP BY '+spec.owner+' ORDER BY owner')).rows;
  phase('sentinel_hash',t);
  // Digest is a sorted multiset of record-SHA256, avoiding one enormous value/content dump.
  out[t]=(await db.query("SELECT owner,count(*)::text AS n,encode(sha256(convert_to(string_agg(h,'' ORDER BY h),'UTF8')),'hex') AS sha256 FROM (SELECT "+spec.owner+"::text AS owner,encode(sha256(convert_to(to_jsonb(t)::text,'UTF8')),'hex') AS h FROM "+table+" t "+spec.join+") q GROUP BY owner ORDER BY owner")).rows;
  same(out[t].map(({owner,n})=>({owner,n})),counts,'f3_projektbestand_geaendert');
 }
 return out;
 }catch(e){primary=true;capture(e,'pg');throw e;}finally{if(policy){phase('sentinel_restore');try{await db.query("SELECT set_config('statement_timeout',$1,false)",[old]);}catch(e){capture(e,'pg');if(!primary)throw e;}}}
}
/** Informational whole-project snapshots use one read-only MVCC snapshot.
 * Their differences describe concurrent work; they NEVER gate a Reverse commit.
 */
async function projectInformation(db,h){
 // Keep informational read failures out of the mutation guard's first-cause context.
 return contexts.run({phase:'sentinel_katalog'},async()=>{
  await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  let projects,diagnose;
  try{projects=await projectSentinel(db,h.sentinel);}
  catch(e){capture(e);diagnose={...contexts.getStore().first};}
  finally{await db.query('ROLLBACK');} // A broken connection still fails closed.
  return diagnose?{projects:null,sha256:null,diagnose}:{projects,sha256:hash(projects)};
 });
}
function informationSummary(snapshot){
 return {sha256:snapshot.sha256,...(snapshot.diagnose?{diagnose:snapshot.diagnose}:{})};
}
export function projectDifference(before,after){
 if(before===null||after===null)return {geaendert:null,tabellen:[],nicht_vergleichbar:true};
 const tables=[];
 for(const table of [...new Set([...Object.keys(before),...Object.keys(after)])].sort()){
  const a=before[table]??[],b=after[table]??[];
  if(canon(a)===canon(b))continue;
  const sum=rows=>rows.reduce((n,r)=>n+BigInt(r.n),0n).toString();
  tables.push({tabelle:table,vorher:sum(a),nachher:sum(b),vorher_sha256:hash(a),nachher_sha256:hash(b)});
 }
 return {geaendert:tables.length>0,tabellen:tables};
}
const WRITE_TARGETS=['reverse_code_dateien','reverse_code_symbole','reverse_f3_bereinigungs_batches'];
const WRITE_LOCKS=['RowExclusiveLock','ShareUpdateExclusiveLock','ShareLock','ShareRowExclusiveLock','ExclusiveLock','AccessExclusiveLock'];
/** Incoming FK dependants of the delete/journal heaps, across ALL schemas.
 * Outgoing parents are not CASCADE targets and require only RowShare/AccessShare.
 * UNION de-duplicates self references/cycles; no name-based reachability.
 */
async function dependencySurface(db,roots){
 const relations=(await db.query(`WITH RECURSIVE closure(oid) AS (
  SELECT unnest($1::oid[])
  UNION
  SELECT k.conrelid FROM pg_catalog.pg_constraint k JOIN closure p ON p.oid=k.confrelid WHERE k.contype='f'
 ) SELECT c.oid::text AS oid,c.relname AS name,n.nspname AS schema,c.relkind,c.reltoastrelid::text AS toast_oid
 FROM closure p JOIN pg_catalog.pg_class c ON c.oid=p.oid
 JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace ORDER BY c.oid`,[roots])).rows;
 if(roots.some(oid=>!relations.some(r=>r.oid===oid)))stop('f3_relation_unbekannt');
 // A foreign dependency is a pre-start STOP, never a writable project exception.
 if(relations.some(r=>!r.name.startsWith('reverse_')||!['r','p'].includes(r.relkind)))stop('f3_fk_unbekannt');
 const edges=(await db.query("SELECT oid::text AS oid,conrelid::text AS child_oid,confrelid::text AS parent_oid,pg_get_constraintdef(oid) AS def,convalidated FROM pg_catalog.pg_constraint WHERE contype='f' AND confrelid=ANY($1::oid[]) ORDER BY oid",[relations.map(r=>r.oid)])).rows;
 const heaps=[...relations.map(r=>r.oid),...relations.map(r=>r.toast_oid).filter(oid=>oid!=='0')];
 const indexes=(await db.query("SELECT indrelid::text AS parent_oid,indexrelid::text AS oid FROM pg_catalog.pg_index WHERE indrelid=ANY($1::oid[]) ORDER BY indexrelid",[heaps])).rows;
 return {relations,edges,indexes};
}
/** Exact OID closure, NEVER a pg_toast / schema-name allowlist. */
async function writeSurface(db){
 const roots=(await db.query("SELECT c.oid::text AS oid,c.relname AS name,c.reltoastrelid::text AS toast_oid,c.relrowsecurity,c.relforcerowsecurity FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=current_schema() AND c.relkind='r' AND c.relname=ANY($1::text[]) ORDER BY c.oid",[WRITE_TARGETS])).rows;
 if(roots.length!==3)stop(roots.some(r=>r.name==='reverse_f3_bereinigungs_batches')?'f3_relation_unbekannt':'f3_schema145_fehlt');
 if(roots.some(r=>r.relrowsecurity||r.relforcerowsecurity))stop('f3_rls_unbekannt');
 const oids=roots.map(r=>r.oid);
 const rules=(await db.query("SELECT oid::text AS oid,ev_class::text AS relation_oid FROM pg_catalog.pg_rewrite WHERE ev_class=ANY($1::oid[]) ORDER BY oid",[oids])).rows;
 if(rules.length)stop('f3_regel_unbekannt');
 const policies=(await db.query("SELECT oid::text AS oid,polrelid::text AS relation_oid FROM pg_catalog.pg_policy WHERE polrelid=ANY($1::oid[]) ORDER BY oid",[oids])).rows;
 if(policies.length)stop('f3_rls_unbekannt');
 const triggers=(await db.query("SELECT oid::text AS oid,tgrelid::text AS relation_oid FROM pg_catalog.pg_trigger WHERE tgrelid=ANY($1::oid[]) AND NOT tgisinternal ORDER BY oid",[oids])).rows;
 if(triggers.length)stop('f3_trigger_unbekannt');
 const heaps=[...oids,...roots.map(r=>r.toast_oid).filter(oid=>oid!=='0')];
 const indexes=(await db.query("SELECT indrelid::text AS parent_oid,indexrelid::text AS oid FROM pg_catalog.pg_index WHERE indrelid=ANY($1::oid[]) ORDER BY indexrelid",[heaps])).rows;
 const dependencies=await dependencySurface(db,oids);
 return {roots,rules,policies,triggers,indexes,dependencies};
}
/** Library fault seams are not CLI options. Production always creates a new
 * pg.Client from the caller's existing server connection options, then ends it.
 */
export async function openBatchConnection(options){
 if(!options)stop('f3_batch_verbindung_fehlt');
 const {Client}=createRequire(new URL('../../core/package.json',import.meta.url))('pg');
 const c=new Client(options);
 try{await c.connect();return c;}catch(e){await c.end().catch(()=>{});throw e;}
}
export async function transactionSnapshot(db){
 const rows=(await db.query("SELECT relid::text AS oid,n_tup_ins::text AS ins,n_tup_upd::text AS upd,n_tup_del::text AS del,n_tup_hot_upd::text AS hot FROM pg_catalog.pg_stat_xact_all_tables")).rows;
 const out=new Map();
 for(const r of rows){
  if(out.has(r.oid))stop('f3_tx_delta_abweichung');
  const values={};
  for(const key of ['ins','upd','del','hot']){
   if(typeof r[key]!=='string'||!/^[0-9]+$/.test(r[key]))stop('f3_tx_delta_abweichung');
   values[key]=BigInt(r[key]);
  }
  out.set(r.oid,values);
 }
 return out;
}
/** Delta on the SAME held client, including catalogs/partition leaves/TOAST.
 * pg_stat_xact_* updates continuously; no pg_stat_clear_snapshot/reset is used.
 */
export async function transactionGuard(db,ops,baseline,pinnedSurface){
 phase('tx_schutz');await db.query('SET CONSTRAINTS ALL IMMEDIATE');
 const surface=pinnedSurface??await writeSurface(db);
 const expected=new Map([
  ['reverse_code_dateien',{ins:0n,upd:0n,del:BigInt(ops.filter(x=>x.kind==='file').length),hot:0n}],
  ['reverse_code_symbole',{ins:0n,upd:0n,del:BigInt(ops.filter(x=>x.kind==='symbol').length),hot:0n}],
  ['reverse_f3_bereinigungs_batches',{ins:1n,upd:0n,del:0n,hot:0n}]
 ]);
 const allowed=new Map(surface.roots.map(r=>[r.oid,expected.get(r.name)]));
 const toast=new Map(surface.roots.filter(r=>r.toast_oid!=='0').map(r=>[r.toast_oid,expected.get(r.name)]));
 const current=await transactionSnapshot(db),zero={ins:0n,upd:0n,del:0n,hot:0n};
 for(const oid of baseline.keys())if(!current.has(oid))stop('f3_tx_delta_abweichung');
 for(const oid of allowed.keys())if(!baseline.has(oid)||!current.has(oid))stop('f3_tx_delta_abweichung');
 for(const [oid,actual] of current){
  const before=baseline.get(oid)??zero,delta={};
  for(const key of Object.keys(zero)){
   delta[key]=actual[key]-before[key];
   if(delta[key]<0n)stop('f3_tx_delta_abweichung');
  }
  const want=allowed.get(oid),parent=toast.get(oid);
  if(want){
   if(Object.keys(zero).some(key=>delta[key]!==want[key]))stop('f3_tx_delta_abweichung');
  }else if(parent){
   // Internal chunks vary with compression; permit only the parent's exact kind
   // of operation and only when this batch actually mutates that parent.
   if(delta.upd!==0n||delta.hot!==0n||(parent.ins===0n&&delta.ins!==0n)||(parent.del===0n&&delta.del!==0n))stop('f3_tx_fremdmutation');
  }else if(Object.values(delta).some(n=>n!==0n))stop('f3_tx_fremdmutation');
 }
 // FK CASCADE/SET NULL opens dependency heaps RowExclusive even for zero rows.
 // That lock is permitted ONLY for the manifest-pinned reverse-only FK closure;
 // its tuple DELTA above must still be exactly zero. No cascade writes are allowed.
 phase('tx_locks');
 const targetOids=new Set([...allowed.keys(),...toast.keys(),...surface.indexes.map(r=>r.oid)]);
 const dependencyToast=new Set(surface.dependencies.relations.map(r=>r.toast_oid).filter(oid=>oid!=='0'));
 const dependencyIndexes=new Set(surface.dependencies.indexes.map(r=>r.oid));
 const dependencyOids=new Set([...surface.dependencies.relations.map(r=>r.oid),...dependencyToast,...dependencyIndexes]);
 const locks=(await db.query("SELECT relation::text AS oid,mode FROM pg_catalog.pg_locks WHERE pid=pg_backend_pid() AND granted AND locktype='relation' AND mode=ANY($1::text[])",[WRITE_LOCKS])).rows;
 const rejectLock=async lock=>{
  // Catalog identifiers/OIDs/known mode only; never SQL, payload, paths or credentials.
  const r=(await db.query("SELECT c.relname,n.nspname AS schema,c.relkind,i.indrelid::text AS parent_oid FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace LEFT JOIN pg_catalog.pg_index i ON i.indexrelid=c.oid WHERE c.oid=$1::oid",[lock.oid])).rows[0];
  const journal=surface.roots.find(r=>r.name==='reverse_f3_bereinigungs_batches')?.oid;
  const diag={relname:r?.relname??null,schema:r?.schema??null,oid:lock.oid,relkind:r?.relkind??null,lockmode:lock.mode,
   parent_oid:r?.parent_oid??null,
   erwartet:{ziel:allowed.has(lock.oid),closure:dependencyOids.has(lock.oid),journal:journal===lock.oid,
    index:surface.indexes.some(r=>r.oid===lock.oid)||dependencyIndexes.has(lock.oid),toast:toast.has(lock.oid)||dependencyToast.has(lock.oid)}};
  const e=Error('f3_tx_lock_unerlaubt');lockFailures.set(e,diag);
  // Node's existing TAP runner prints stacks, preserving the fixed public error code.
  e.stack+='\nF3_LOCK_DIAG '+canon(diag);throw e;
 };
 for(const lock of locks){
  if(lock.mode==='RowExclusiveLock'){
   if(!targetOids.has(lock.oid)&&!dependencyOids.has(lock.oid))await rejectLock(lock);
  }else if(lock.mode==='ShareLock'||lock.mode==='ShareRowExclusiveLock'){
   if(!targetOids.has(lock.oid)&&!dependencyOids.has(lock.oid))await rejectLock(lock);
  }else await rejectLock(lock); // Exclusive/AccessExclusive/ShareUpdateExclusive: nowhere.
 }
}

const file=r=>({id:r.id,path:r.file_path,name:r.file_name,source_id:r.source_id,source_sha:r.source_sha,
 code_hash:sha(r.raw),source_hash:sha(r.source_raw),row_bytes:Buffer.byteLength(r.raw)});
async function deadlines(db,s){phase('timeouts');await db.query("SELECT set_config('statement_timeout',$1,true),set_config('lock_timeout',$2,true)",[String(s.statement),String(s.lock)]);}

async function* plannedOperations(db,s,tranche='1'){
 let cursor='';
 for(;;){
  phase('kandidaten');
  const rows=(await db.query('SELECT '+cols+' FROM reverse_code_dateien c JOIN reverse_dateien d ON d.id=c.datei_id AND d.eintrag_id=c.eintrag_id WHERE '+eligibleFor(tranche)+' AND c.id COLLATE "C">$3::text COLLATE "C" ORDER BY c.id COLLATE "C" LIMIT $4',[ENTRY,formatsFor(tranche),cursor,s.rows])).rows;
  if(!rows.length)break;
  for(const r of rows){
   const f=file(r);if(!validName(f.name))stop('f3_dateiname');
   let after='',pending=0;
   for(;;){
    phase('symbole');
    const ss=(await db.query(`SELECT id,to_jsonb(s)::text AS raw FROM reverse_code_symbole s WHERE eintrag_id=$1 AND file_path=$2 AND id COLLATE "C">$3::text COLLATE "C" ORDER BY id COLLATE "C" LIMIT $4`,[ENTRY,f.path,after,s.rows])).rows;
    if(!ss.length)break;
    const ops=ss.map(v=>{
     const raw=JSON.parse(v.raw);
     if(String(raw.datei_id)!==f.source_id||raw.schicht!=='S1'||raw.parser_generation_id!==null)stop('f3_symbol_geaendert');
     return {kind:'symbol',id:v.id,file:f,hash:sha(v.raw),row_bytes:Buffer.byteLength(v.raw)};
    });
    await dependencyGuard(db,'symbol',ops);pending+=ops.length;
    yield* ops;after=ss.at(-1).id;
   }
   await dependencyGuard(db,'file',[{file:f}],pending);
   yield {kind:'file',id:f.id,file:f,hash:f.code_hash,row_bytes:f.row_bytes};
  }
  cursor=rows.at(-1).id;
 }
}

export function encodeRecord(value,limit){
 const raw=canon(value)+'\n';
 if(Buffer.byteLength(raw)>limit)stop('f3_manifest_record_zu_gross');
 return raw;
}
export function* metadataRecords(projects,hinweise){
 for(const table of Object.keys(projects).sort()){
  yield {kind:'project_table',table,owners:projects[table].length};
  for(const row of projects[table])yield {kind:'project_owner',table,owner:row.owner,n:row.n,sha256:row.sha256};
 }
 for(const hinweis of hinweise)yield {kind:'hinweis',hinweis};
}
export function manifestHeader(settings,sentinel,projects,hinweise,katalog_sha256,tranche='1'){
 trancheValue(tranche);
 return {kind:'header',version:4,scope:trancheScope(tranche),entry:ENTRY,settings,sentinel,katalog_sha256,
  ...(tranche==='2a'?{tranche:'2a',qualifikation:qualification()}:{}),
  metadaten:{project_tables:Object.keys(projects).length,project_owners:Object.values(projects).reduce((n,a)=>n+a.length,0),
   hinweise:hinweise.length,projects_sha256:hash(projects),hinweise_sha256:hash(hinweise)}};
}
function validHinweis(x){
 return x?.code==='f3_terminaler_altmarker'&&typeof x.job_id==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(x.job_id)&&TERMINAL_JOBS.includes(x.state)&&Number.isSafeInteger(x.attempt)&&x.attempt>=0;
}
/** Metadata is reconstructed only for the reviewed table/owner sentinels, never
 * for all candidate IDs. Empty tables get explicit table records.
 */
async function* operationStream(lines,onHeader,onRaw){
 let header,remaining=0,currentTable='',lastTable='',tables=0,owners=0,hints=false,ready=false;
 const ownerSeen=new Set(),hintSeen=new Set();
 const finish=()=>{
  if(ready)return;
  if(!header||remaining!==0||tables!==header.metadaten.project_tables||owners!==header.metadaten.project_owners||header.hinweise.length!==header.metadaten.hinweise)stop('f3_manifest_metadaten');
  if(hash(header.projects)!==header.metadaten.projects_sha256||hash(header.hinweise)!==header.metadaten.hinweise_sha256)stop('f3_manifest_metadaten');
  ready=true;onHeader(header);
 };
 for await(const raw of lines()){
  onRaw?.(raw);let x;try{x=JSON.parse(raw);}catch{stop('f3_manifest_json');}
  if(canon(x)+'\n'!==raw)stop('f3_manifest_nicht_kanonisch');
  if(!header){
   validateHeader(x);encodeRecord(x,x.settings.recordBytes);
   header={...x,projects:Object.create(null),hinweise:[]};continue;
  }
  encodeRecord(x,header.settings.recordBytes);
  if(['project_table','project_owner','hinweis'].includes(x.kind)){
   if(ready)stop('f3_manifest_metadaten');
   if(x.kind==='project_table'){
    if(hints||remaining!==0||typeof x.table!=='string'||!/^[a-z_][a-z0-9_]*$/.test(x.table)||x.table<=lastTable||!Number.isSafeInteger(x.owners)||x.owners<0||tables>=header.metadaten.project_tables)stop('f3_manifest_metadaten');
    lastTable=currentTable=x.table;remaining=x.owners;ownerSeen.clear();tables++;header.projects[x.table]=[];
   }else if(x.kind==='project_owner'){
    if(hints||!currentTable||x.table!==currentTable||remaining<1||typeof x.owner!=='string'||ownerSeen.has(x.owner)||typeof x.n!=='string'||!/^[1-9][0-9]*$/.test(x.n)||!validHash(x.sha256)||owners>=header.metadaten.project_owners)stop('f3_manifest_metadaten');
    ownerSeen.add(x.owner);header.projects[currentTable].push({owner:x.owner,n:x.n,sha256:x.sha256});remaining--;owners++;
   }else{
    if(remaining!==0||tables!==header.metadaten.project_tables||owners!==header.metadaten.project_owners||!validHinweis(x.hinweis)||hintSeen.has(x.hinweis.job_id)||header.hinweise.length>=header.metadaten.hinweise)stop('f3_manifest_metadaten');
    hints=true;hintSeen.add(x.hinweis.job_id);header.hinweise.push(x.hinweis);
   }
   continue;
  }
  finish();validateOp(x,headerTranche(header));yield x;
 }
 finish();
}

export async function createManifest(pool,emit,{sentinelTimeoutMs,tranche='1'}={}){
 trancheValue(tranche);
 return diagnosed(async()=>{
 phase('db_connect');
 const db=await observed(pool).connect(),digest=createHash('sha256');let files=0,symbols=0,s,broken=false;
 const send=async x=>{const raw=encodeRecord(x,s.recordBytes);digest.update(raw);await emit?.(raw);};
 try{
  phase('db_begin');await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  s=await settings(db);await deadlines(db,s);const katalog=await schemaGuard(db);await journalGuard(db);const hinweise=await quiet(db);
  const sentinel=sentinelPolicy(s,sentinelTimeoutMs),projects=await projectSentinel(db,sentinel);
  const header=manifestHeader(s,sentinel,projects,hinweise,katalog,tranche);
  // Validate EVERY record before output, using the same record budget as the writer.
  phase('manifest_header');encodeRecord(header,s.recordBytes);
  phase('manifest_metadaten');for(const row of metadataRecords(projects,hinweise))encodeRecord(row,s.recordBytes);
  // Full read-only guard pass BEFORE the first header. Same stable snapshot as output.
  for await(const op of plannedOperations(db,s,tranche)){validateOp(op,tranche);phase('manifest_records');encodeRecord(op,s.recordBytes);}
  phase('manifest_header');await send(header);
  phase('manifest_metadaten');for(const row of metadataRecords(projects,hinweise))await send(row);
  for await(const op of plannedOperations(db,s,tranche)){
   phase('manifest_records');await send(op);if(op.kind==='file')files++;else symbols++;
  }
  phase('abschluss');await db.query('ROLLBACK');return {sha256:digest.digest('hex'),files,symbols,sentinel,hinweise_anzahl:hinweise.length,metadaten:header.metadaten,
    ...(tranche==='2a'?{tranche:'2a',qualifikation:header.qualifikation}:{})};
 }catch(e){capture(e);await db.query('ROLLBACK').catch(()=>{broken=true;});throw e;}finally{db.release(broken);}
 });
}

export function validateHeader(h){
 if(h?.kind!=='header'||h.version!==4||![trancheScope('1'),trancheScope('2a')].includes(h.scope)||h.entry!==ENTRY||
    Object.hasOwn(h,'projects')||Object.hasOwn(h,'hinweise')||!h.settings||!validHash(h.settings.revision)||!validHash(h.katalog_sha256))stop('f3_manifest_header');
 if(headerTranche(h)==='2a'){
  if(h.tranche!=='2a')stop('f3_manifest_header');
  same(h.qualifikation,qualification(),'f3_manifest_header');
 }else if(Object.hasOwn(h,'tranche')||Object.hasOwn(h,'qualifikation'))stop('f3_manifest_header');
 const m=h.metadaten;
 if(!m||!validHash(m.projects_sha256)||!validHash(m.hinweise_sha256))stop('f3_manifest_header');
 for(const k of ['project_tables','project_owners','hinweise'])if(!Number.isSafeInteger(m[k])||m[k]<0)stop('f3_manifest_header');
 if(!h.sentinel||!['pg','cli'].includes(h.sentinel.quelle))stop('f3_manifest_header');
 same(h.sentinel,sentinelPolicy(h.settings,h.sentinel.quelle==='cli'?h.sentinel.timeout_ms:undefined),'f3_manifest_header');
 for(const k of ['rows','maxBytes','recordBytes','statement','lock'])
  if(!Number.isSafeInteger(h.settings[k])||h.settings[k]<1)stop('f3_manifest_budget');
}
function validateOp(x,tranche='1'){
 const f=x?.file;
 if(!['symbol','file'].includes(x?.kind)||typeof x.id!=='string'||!x.id||!validHash(x.hash)||
    !Number.isSafeInteger(x.row_bytes)||x.row_bytes<1||!f||typeof f.id!=='string'||
    typeof f.path!=='string'||!validName(f.name)||!validTrancheFile(f,tranche)||f.path.split('/').at(-1)!==f.name||
    !/^[1-9][0-9]*$/.test(f.source_id)||!validHash(f.source_sha)||!validHash(f.source_hash)||!validHash(f.code_hash)||
    !Number.isSafeInteger(f.row_bytes)||f.row_bytes<1||
    (x.kind==='file'&&(x.id!==f.id||x.hash!==f.code_hash||x.row_bytes!==f.row_bytes)))stop('f3_manifest_op');
}
export async function verifyManifest(lines,expected,backup=''){
 if(!validHash(expected))stop('f3_manifest_hash');
 const digest=createHash('sha256');let header,previousFile='',previousSymbol='',current=null,closed=true,n=0,approved=[],cost;
 const proofs=[];
 for await(const x of operationStream(lines,h=>{header=h;cost=batchBase({...h,backup});},raw=>digest.update(raw))){
  if(current?.id!==x.file.id){
   if(!closed||compareIds(x.file.id,previousFile)<=0)stop('f3_manifest_reihenfolge');
   current=x.file;previousFile=x.file.id;previousSymbol='';closed=false;
  }else same(current,x.file,'f3_manifest_quellkonflikt');
  if(closed)stop('f3_manifest_reihenfolge');
  if(x.kind==='symbol'){
   if(compareIds(x.id,previousSymbol)<=0)stop('f3_manifest_reihenfolge');previousSymbol=x.id;
  }else closed=true;
  let proposed=addCost(cost,x);
  if(approved.length&&(proposed.rows>header.settings.rows||proposed.bytes>header.settings.maxBytes)){
   proofs.push(hash(approved));approved=[];cost=batchBase({...header,backup});proposed=addCost(cost,x);
  }
  if(proposed.rows>header.settings.rows||proposed.bytes>header.settings.maxBytes)stop('f3_einzelzeile_ueber_budget');
  approved.push(x);cost=proposed;n++;
 }
 if(approved.length)proofs.push(hash(approved));
 if(!header||!closed||digest.digest('hex')!==expected)stop('f3_manifest_hash');
 return {header,operations:n,proofs};
}
function payload(h,pin,n,ops,backup,zwischen=0){
 return {eintrag_id:ENTRY,manifest_sha256:pin,batch_nr:String(n),batch_sha256:hash(ops),ops,
  delta:{...(headerTranche(h)==='2a'?{tranche:'2a',qualifikation:h.qualifikation}:{}),files:ops.filter(x=>x.kind==='file').length,symbols:ops.filter(x=>x.kind==='symbol').length,sentinel:h.sentinel,pruefungen:{vollsentinel_alle_batches:zwischen},katalog_sha256:h.katalog_sha256},
  backup_beleg:backup,projekt_sentinel_sha256:h.metadaten.projects_sha256,einstellungen_revision:h.settings.revision};
}
/** Linear accounting: candidate count never enlarges a record/header.
 * Charge explicit deletes + journal row, complete row bytes and conservative wire cost.
 * Metadata digest is computed ONCE, never rehash the full sentinel set per candidate.
 */
function batchBase(h){
 return {rows:1,bytes:8+size({entry:ENTRY,pin:'0'.repeat(64),batch:'9223372036854775807',backup:h.backup,
  settings:h.settings.revision,sentinel:h.sentinel,projects:h.metadaten.projects_sha256,katalog:h.katalog_sha256,vollsentinel_alle_batches:Number.MAX_SAFE_INTEGER})+
  (headerTranche(h)==='2a'?4*size({tranche:'2a',qualifikation:h.qualifikation}):0)};
}
const addCost=(c,x)=>({rows:c.rows+1,bytes:c.bytes+x.row_bytes+4*size(x)+4});
export function batchCost(h,ops){return ops.reduce(addCost,batchBase(h));}
export async function* batches(lines,h,backup){
 let ops=[],cost=batchBase({...h,backup});
 for await(const x of operationStream(lines,actual=>same(actual,h,'f3_manifest_metadaten_geaendert'))){
  let next=addCost(cost,x);
  if(ops.length&&(next.rows>h.settings.rows||next.bytes>h.settings.maxBytes)){
   yield ops;ops=[];cost=batchBase({...h,backup});next=addCost(cost,x);
  }
  if(next.rows>h.settings.rows||next.bytes>h.settings.maxBytes)stop('f3_einzelzeile_ueber_budget');
  ops.push(x);cost=next;
 }
 if(ops.length)yield ops;
}
async function journalGuard(db){
 phase('journal');
 const name=(await db.query("SELECT to_regclass(format('%I.reverse_f3_bereinigungs_batches',current_schema())) AS t")).rows[0].t;
 if(!name)stop('f3_schema145_fehlt');
 const columns=(await db.query("SELECT column_name,data_type FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='reverse_f3_bereinigungs_batches' ORDER BY ordinal_position")).rows;
 same(columns.map(x=>[x.column_name,x.data_type]),[
  ['eintrag_id','text'],['manifest_sha256','text'],['batch_nr','bigint'],['batch_sha256','text'],
  ['ops','jsonb'],['delta','jsonb'],['backup_beleg','text'],['projekt_sentinel_sha256','text'],
  ['einstellungen_revision','text'],['abgeschlossen_am','timestamp with time zone']
 ],'f3_schema145_abweichend');
 const constraints=(await db.query("SELECT contype,pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conrelid='reverse_f3_bereinigungs_batches'::regclass AND contype IN('p','f') ORDER BY contype")).rows;
 same(constraints,[
  {contype:'f',def:'FOREIGN KEY (eintrag_id) REFERENCES reverse_eintraege(id) ON DELETE RESTRICT'},
  {contype:'p',def:'PRIMARY KEY (eintrag_id, manifest_sha256, batch_nr)'}
 ],'f3_schema145_abweichend');
 const unsafe=(await db.query("SELECT tgname FROM pg_trigger WHERE tgrelid='reverse_f3_bereinigungs_batches'::regclass AND NOT tgisinternal UNION ALL SELECT conname FROM pg_constraint WHERE contype='f' AND confrelid='reverse_f3_bereinigungs_batches'::regclass")).rows;
 if(unsafe.length)stop('f3_journal_nebenwirkung');
}
async function dependencyGuard(db,kind,ops,projectedSymbols=null){
 phase('abhaengigkeiten');
 if(!ops.length)return;
 if(kind==='symbol'){
  const ids=ops.map(x=>x.id);
  if((await db.query("SELECT 1 FROM reverse_code_symbole WHERE parent_symbol=ANY($1::text[]) UNION ALL SELECT 1 FROM reverse_code_verweise WHERE symbol_id=ANY($1::text[]) UNION ALL SELECT 1 FROM reverse_code_kanten WHERE target_symbol_id=ANY($1::text[]) LIMIT 1",[ids])).rows.length)stop('f3_abhaengigkeit_stop');
 }else{
  const paths=ops.map(x=>x.file.path);
  if(projectedSymbols===null){
   if((await db.query("SELECT 1 FROM reverse_code_symbole WHERE eintrag_id=$1 AND file_path=ANY($2::text[]) LIMIT 1",[ENTRY,paths])).rows.length)stop('f3_abhaengigkeit_stop');
  }else{
   if(ops.length!==1)stop('f3_abhaengigkeit_stop');
   const n=(await db.query("SELECT count(*)::text AS n FROM reverse_code_symbole WHERE eintrag_id=$1 AND file_path=$2",[ENTRY,paths[0]])).rows[0].n;
   if(BigInt(n)!==BigInt(projectedSymbols))stop('f3_abhaengigkeit_stop');
  }
  if((await db.query("SELECT 1 FROM reverse_code_verweise WHERE eintrag_id=$1 AND file_path=ANY($2::text[]) UNION ALL SELECT 1 FROM reverse_code_statements WHERE eintrag_id=$1 AND file_path=ANY($2::text[]) UNION ALL SELECT 1 FROM reverse_code_kanten WHERE eintrag_id=$1 AND file_path=ANY($2::text[]) LIMIT 1",[ENTRY,paths])).rows.length)stop('f3_abhaengigkeit_stop');
 }
}
async function absent(db,ops){
 for(const kind of ['symbol','file']){
  const own=ops.filter(x=>x.kind===kind);if(!own.length)continue;
  const table=kind==='symbol'?'reverse_code_symbole':'reverse_code_dateien';
  if((await db.query('SELECT 1 FROM '+table+' WHERE eintrag_id=$1 AND id=ANY($2::text[]) LIMIT 1',[ENTRY,own.map(x=>x.id)])).rows.length)stop('f3_journal_daten_widerspruch');
 }
}
async function deleteBatch(db,ops,{beforeDelete,tranche='1'}={}){
 const fs=new Map(ops.map(x=>[x.file.id,x.file]));
 const rows=(await db.query('SELECT '+cols+' FROM reverse_code_dateien c JOIN reverse_dateien d ON d.id=c.datei_id AND d.eintrag_id=c.eintrag_id WHERE '+eligibleFor(tranche)+' AND c.id=ANY($3::text[]) ORDER BY c.id FOR UPDATE OF c,d',[ENTRY,formatsFor(tranche),[...fs.keys()]])).rows;
 if(rows.length!==fs.size)stop('f3_quelle_geaendert');
 for(const r of rows)same(file(r),fs.get(r.id),'f3_quelle_geaendert');
 for(const kind of ['symbol','file']){
  const own=ops.filter(x=>x.kind===kind);if(!own.length)continue;
  const table=kind==='symbol'?'reverse_code_symbole':'reverse_code_dateien';
  if(kind==='symbol'){
   const rows=(await db.query("SELECT id,file_path,datei_id::text,schicht,parser_generation_id,to_jsonb(s)::text AS raw FROM reverse_code_symbole s WHERE eintrag_id=$1 AND id=ANY($2::text[]) ORDER BY id FOR UPDATE",[ENTRY,own.map(x=>x.id)])).rows;
   const by=new Map(rows.map(x=>[x.id,x]));
   for(const x of own){
    const r=by.get(x.id);
    if(!r||r.file_path!==x.file.path||r.datei_id!==x.file.source_id||r.schicht!=='S1'||r.parser_generation_id!==null||sha(r.raw)!==x.hash||Buffer.byteLength(r.raw)!==x.row_bytes)stop('f3_symbol_geaendert');
   }
  }
  await dependencyGuard(db,kind,own);
  await beforeDelete?.({db,kind,ops:own});
  const targets=own.map(x=>({id:x.id,path:x.file.path,source:x.file.source_id}));
  const result=await db.query('DELETE FROM '+table+" s USING jsonb_to_recordset($2::jsonb) x(id text,path text,source bigint) WHERE s.eintrag_id=$1 AND s.id=x.id AND s.file_path=x.path AND s.datei_id=x.source AND s.schicht='S1' AND s.parser_generation_id IS NULL RETURNING s.id",[ENTRY,JSON.stringify(targets)]);
  same(result.rows.map(x=>x.id).sort(),own.map(x=>x.id).sort(),'f3_loeschmenge_geaendert');
 }
}
/** lines() must reopen the same reviewed immutable stream. CLI pins its open FD.
 * Fault hooks are library-only, not exposed as command-line mutation controls.
 */

export function pruefeZwischenIntervall(n,batches){
 if(!Number.isSafeInteger(n)||n<0||n>batches)stop('f3_zwischen_budget');
 return n;
}
export async function applyManifest(pool,{lines,expected,backup,beforeDelete,afterDelete,afterCommit,onBatch,onInformation,zwischenSentinelBatches=0,tranche:expectedTranche}){
 return diagnosed(async()=>{
 const batchOptions=pool.options,batchFactory=pool.connectFresh?.bind(pool);
 const batchConnect=async()=>{phase('db_connect');try{return observed(await (batchFactory?batchFactory():openBatchConnection(batchOptions)));}catch(e){capture(e,'pg');throw e;}};
 pool=observed(pool);phase('manifest_pruefen');
 if(typeof backup!=='string'||backup.trim().length<8)stop('f3_sicherungsbeleg_fehlt');
 const {header:h,proofs}=await verifyManifest(lines,expected,backup);
 const tranche=headerTranche(h);
 if(expectedTranche!==undefined&&trancheValue(expectedTranche)!==tranche)stop('f3_manifest_header');
 const zwischen=pruefeZwischenIntervall(zwischenSentinelBatches,proofs.length);
 const lock=await pool.connect();let held=false,committed=0,resumed=0,number=0;
 let startProjects,intermediateChecks=0,intermediateChanges=0;
 const intermediate=async(db,index)=>{
  if(zwischen>0&&(index+1)%zwischen===0&&index+1<proofs.length){
   const snapshot=await projectInformation(db,h);intermediateChecks++;
   if(projectDifference(startProjects.projects,snapshot.projects).geaendert)intermediateChanges++;
  }
 };
 try{
  held=(await lock.query('SELECT pg_try_advisory_lock(hashtext($1)) AS ok',['p18-t97-f3:'+ENTRY])).rows[0].ok;
  if(!held)stop('f3_bereinigung_laeuft');
  await journalGuard(lock);await quiet(lock);same(await settings(lock),h.settings,'f3_einstellungen_geaendert');
  await checkCatalog(lock,h);
  startProjects=await projectInformation(lock,h); // Informational START, independent of the dry-run date.
  await onInformation?.({zeitpunkt:'start',informativ:true,...informationSummary(startProjects),vergleich:projectDifference(h.projects,startProjects.projects)});
  for await(const ops of batches(lines,h,backup)){
   if(hash(ops)!==proofs[number])stop('f3_manifest_batch_geaendert');
   const evidence=payload(h,expected,number,ops,backup,zwischen),c=await batchConnect();let done=false;
   try{
    await c.query('BEGIN ISOLATION LEVEL READ COMMITTED');
    phase('tx_baseline');const baseline=await transactionSnapshot(c);
    await deadlines(c,h.settings);
    await c.query("SELECT pg_advisory_xact_lock_shared(hashtext('reverse-pipeline-halt'))");
    await quiet(c);same(await settings(c),h.settings,'f3_einstellungen_geaendert');await journalGuard(c);
    // Reverse-only writer barriers cover both catalog checks and all explicit deletes.
    const schema=(await c.query('SELECT current_schema() AS s')).rows[0].s;
    await c.query('LOCK TABLE '+['reverse_code_dateien','reverse_code_symbole'].map(t=>ident(schema)+'.'+ident(t)).join(',')+' IN SHARE ROW EXCLUSIVE MODE');
    await checkCatalog(c,h);
    const old=(await c.query("SELECT eintrag_id,manifest_sha256,batch_nr::text,batch_sha256,ops,delta,backup_beleg,projekt_sentinel_sha256,einstellungen_revision FROM reverse_f3_bereinigungs_batches WHERE eintrag_id=$1 AND manifest_sha256=$2 AND batch_nr=$3 FOR UPDATE",[ENTRY,expected,String(number)])).rows[0];
    if(old){
     same(old,evidence,'f3_journal_konflikt');await absent(c,ops);
     await c.query('ROLLBACK');resumed++;await intermediate(c,number);number++;continue;
    }
    await deleteBatch(c,ops,{beforeDelete,tranche});await afterDelete?.({db:c,batch:number,ops});
    await quiet(c);same(await settings(c),h.settings,'f3_einstellungen_geaendert');
    const cost=batchCost({...h,backup},ops);
    if(cost.rows>h.settings.rows||cost.bytes>h.settings.maxBytes)stop('f3_tx_budget');
    await c.query("INSERT INTO reverse_f3_bereinigungs_batches(eintrag_id,manifest_sha256,batch_nr,batch_sha256,ops,delta,backup_beleg,projekt_sentinel_sha256,einstellungen_revision) VALUES($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7,$8,$9)",
     [ENTRY,expected,String(number),evidence.batch_sha256,JSON.stringify(ops),JSON.stringify(evidence.delta),backup,evidence.projekt_sentinel_sha256,h.settings.revision]);
    const pinnedSurface=await checkCatalog(c,h); // SAME manifest-verified OID evidence for the lock gate.
    await transactionGuard(c,ops,baseline,pinnedSurface); // LAST gate; no writes follow before COMMIT.
    phase('commit');await c.query('COMMIT');done=true;committed++;
    await afterCommit?.({batch:number});
    await intermediate(c,number);
    await onBatch?.({batch:number,manifest:expected,delta:evidence.delta,cost});
    number++;
   }catch(e){
    capture(e);if(!done)await c.query('ROLLBACK').catch(()=>{});
    e.committed_batches=committed;e.resumed_batches=resumed;throw e;
   }finally{await c.end();}
  }
  const count=(await lock.query('SELECT count(*)::text AS n FROM reverse_f3_bereinigungs_batches WHERE eintrag_id=$1 AND manifest_sha256=$2',[ENTRY,expected])).rows[0].n;
  if(number!==proofs.length||BigInt(count)!==BigInt(number))stop('f3_journal_konflikt');
  await checkCatalog(lock,h);
  const final=await projectInformation(lock,h);phase('endbilanz');
  await onInformation?.({zeitpunkt:'ende',informativ:true,...informationSummary(final),vergleich:projectDifference(startProjects.projects,final.projects)});
  return {status:'fertig',manifest:expected,committed_batches:committed,resumed_batches:resumed,
   ...(tranche==='2a'?{tranche:'2a'}:{}),
   projektschutz:'eigene_batch_transaktion',
   projektbilanz:{informativ:true,dryrun_sha256:hash(h.projects),start:informationSummary(startProjects),ende:informationSummary(final),
    dryrun_zu_start:projectDifference(h.projects,startProjects.projects),start_zu_ende:projectDifference(startProjects.projects,final.projects),
    zwischen_pruefungen:intermediateChecks,zwischen_abweichungen:intermediateChanges},
   pruefungen:{vollsentinel_alle_batches:zwischen,regulaere_vollpruefungen:2},katalog_sha256:h.katalog_sha256};
 }catch(e){e.committed_batches??=committed;e.resumed_batches??=resumed;capture(e);throw e;}finally{
  try{if(held)await lock.query('SELECT pg_advisory_unlock(hashtext($1))',['p18-t97-f3:'+ENTRY]);}finally{lock.release();}
 }
});
}
/** Bounded JSONL reader: never collect all symbol IDs or unbounded lines in RAM. */
export async function* fileLines(handle,max){
 let offset=0,rest=Buffer.alloc(0);
 for(;;){
  const block=Buffer.alloc(Math.min(max+1,65536)),r=await handle.read(block,0,block.length,offset);
  if(!r.bytesRead)break;offset+=r.bytesRead;rest=Buffer.concat([rest,block.subarray(0,r.bytesRead)]);
  for(;;){const i=rest.indexOf(10);if(i<0)break;if(i+1>max)stop('f3_manifest_record_zu_gross');
   yield rest.subarray(0,i+1).toString('utf8');rest=rest.subarray(i+1);}
  if(rest.length>max)stop('f3_manifest_record_zu_gross');
 }
 if(rest.length)stop('f3_manifest_fragment');
}
async function auditPath(filename,forbidden){
 const dir=await realpath(path.dirname(path.resolve(filename)));
 for(const root of forbidden.filter(Boolean)){
  const r=path.resolve(root);let real=r;try{real=await realpath(r);}catch(e){if(e.code!=='ENOENT')throw e;}
  if([r,real].some(x=>dir===x||dir.startsWith(x+path.sep)))stop('f3_belegpfad_verboten');
 }
 return {dir,file:path.join(dir,path.basename(filename))};
}
export async function main(argv=process.argv.slice(2)){
 return diagnosed(async()=>{
 const a={};for(let i=0;i<argv.length;i++){
  const k=argv[i];if(!['--eintrag','--tranche','--manifest','--manifest-sha256','--backup-beleg','--ausfuehren','--sentinel-timeout-ms','--vollsentinel-alle-batches'].includes(k)||Object.hasOwn(a,k))stop('f3_parameter');
  a[k]=k==='--ausfuehren'?true:argv[++i];if(a[k]===undefined||a[k]==='')stop('f3_parameter');
 }
 if(a['--eintrag']!==ENTRY)stop('f3_eintrag_nicht_freigegeben');
 const tranche=trancheValue(a['--tranche']??'1');
 const {getAssetKonfiguration}=await import('@synapse/core'),cfg=getAssetKonfiguration();
 const forbidden=[cfg.speicher.root,cfg.speicher.reverseRoot,fileURLToPath(new URL('../../..',import.meta.url))];
 const {Pool}=createRequire(new URL('../../core/package.json',import.meta.url))('pg');
 if(!process.env.DATABASE_URL)stop('f3_datenbank_fehlt');
 if(a['--vollsentinel-alle-batches']!==undefined&&(!a['--ausfuehren']||!/^(0|[1-9][0-9]*)$/.test(a['--vollsentinel-alle-batches'])))stop('f3_zwischen_budget');
 const zwischenSentinelBatches=Number(a['--vollsentinel-alle-batches']??0);
 const pool=observed(new Pool({connectionString:process.env.DATABASE_URL}));
 if(a['--sentinel-timeout-ms']!==undefined&&!/^[1-9][0-9]*$/.test(a['--sentinel-timeout-ms']))stop('f3_sentinel_budget');
 const sentinelTimeoutMs=a['--sentinel-timeout-ms']===undefined?undefined:Number(a['--sentinel-timeout-ms']);
 if(sentinelTimeoutMs!==undefined)sentinelPolicy({statement:sentinelTimeoutMs},sentinelTimeoutMs);
 if(a['--ausfuehren']&&sentinelTimeoutMs!==undefined)stop('f3_sentinel_im_manifest_gepinnt');
 try{
  if(!a['--ausfuehren']){
   let out;
   try{
    if(a['--manifest']){
     phase('audit_open');const p=await auditPath(a['--manifest'],forbidden);
     out=await open(p.file,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
    }
    const result=await createManifest(pool,async raw=>{if(out)await out.writeFile(raw);},{sentinelTimeoutMs,tranche});
    phase('manifest_sync');if(out){await out.chmod(0o444);await out.sync();}
    console.log(JSON.stringify({status:'dry-run',...result}));return;
   }catch(e){capture(e);throw e;}finally{await out?.close();}
  }
  if(!a['--manifest'])stop('f3_manifest_fehlt');
  const p=await auditPath(a['--manifest'],forbidden),input=await open(p.file,constants.O_RDONLY|constants.O_NOFOLLOW);
  try{
   const stat=await input.stat({bigint:true});
   if(!stat.isFile()||stat.nlink!==1n||(Number(stat.mode)&0o222)!==0)stop('f3_manifest_nicht_versiegelt');
   const s=await settings(pool),fingerprint=st=>[String(st.ino),String(st.dev),String(st.size),String(st.mtimeNs),String(st.ctimeNs)];
   const lines=async function*(){
    same(fingerprint(await input.stat({bigint:true})),fingerprint(stat),'f3_manifest_geaendert');
    yield* fileLines(input,s.recordBytes);
    same(fingerprint(await input.stat({bigint:true})),fingerprint(stat),'f3_manifest_geaendert');
   };
   console.log(JSON.stringify(await applyManifest(pool,{lines,expected:a['--manifest-sha256'],backup:a['--backup-beleg'],zwischenSentinelBatches,tranche,
    onBatch:row=>console.log(JSON.stringify({status:'batch_committed',...row})),
    onInformation:row=>console.log(JSON.stringify({status:'projektbilanz',...row}))})));
  }catch(e){capture(e);throw e;}finally{await input.close();}
 }catch(e){capture(e);throw e;}finally{await pool.end();}
 });
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 main().catch(e=>{console.error(JSON.stringify(failureDiagnostic(e)));process.exitCode=1;});
}
