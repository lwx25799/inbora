import {parentPort,workerData} from 'node:worker_threads';
import {readFile} from 'node:fs/promises';
import {parseDocument} from './import-parser.js';
import {Blocked} from '../core/contracts.js';
try{parentPort!.postMessage({ok:true,result:await parseDocument(workerData.name,await readFile(workerData.file))});}
catch(error){parentPort!.postMessage({ok:false,error:error instanceof Blocked?error.code:'KNOWLEDGE_PARSE_FAILED'});}
