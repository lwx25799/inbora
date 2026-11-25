import {randomUUID} from 'node:crypto';
import {readFile,writeFile,rename} from 'node:fs/promises';
import {join} from 'node:path';
import type {AiSettings} from './contracts.js';

export async function saveAiSettings(root:string,settings:Omit<AiSettings,'model'>,preserveLegacyModel=false){
  const file=join(root,'client-settings.json'),temporary=`${file}.${randomUUID()}.tmp`;
  let model: string | undefined;
  if (preserveLegacyModel) {
    try {
      const previous = JSON.parse(await readFile(file, 'utf8'));
      if (typeof previous?.model === 'string') model = previous.model;
    } catch (error) {
      if (!(error instanceof SyntaxError) && (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  await writeFile(temporary,JSON.stringify({...settings,model}),{flag:'wx',mode:0o600});await rename(temporary,file);
}
