import {expect,test,afterEach} from 'vitest';
import {mkdtemp,rm,mkdir,readdir} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {crc32} from 'node:zlib';
import ExcelJS from 'exceljs';
import {parseDocument} from '../../src/knowledge/import-parser.js';
import {mapChat,mapChatPreview} from '../../src/knowledge/import-mapping.js';
import {KnowledgeImports} from '../../src/knowledge/imports.js';
const roots:string[]=[];
afterEach(async()=>{for(const root of roots.splice(0))await rm(root,{recursive:true,force:true});});
function zip(files:Record<string,string>){
  const locals:Buffer[]=[],central:Buffer[]=[];let offset=0;
  for(const [name,text]of Object.entries(files)){
    const key=Buffer.from(name),data=Buffer.from(text),crc=crc32(data),header=Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50);header.writeUInt16LE(20,4);header.writeUInt32LE(crc,14);
    header.writeUInt32LE(data.length,18);header.writeUInt32LE(data.length,22);header.writeUInt16LE(key.length,26);
    locals.push(header,key,data);const entry=Buffer.alloc(46);entry.writeUInt32LE(0x02014b50);entry.writeUInt16LE(20,6);
    entry.writeUInt32LE(crc,16);entry.writeUInt32LE(data.length,20);entry.writeUInt32LE(data.length,24);
    entry.writeUInt16LE(key.length,28);entry.writeUInt32LE(offset,42);central.push(entry,key);offset+=header.length+key.length+data.length;
  }
  const directory=Buffer.concat(central),end=Buffer.alloc(22);end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(Object.keys(files).length,8);end.writeUInt16LE(Object.keys(files).length,10);
  end.writeUInt32LE(directory.length,12);end.writeUInt32LE(offset,16);return Buffer.concat([...locals,directory,end]);
}
test('UTF8 text and CSV preserve long identifiers and quoted newlines',async()=>{
  const csv=await parseDocument('chat.csv',Buffer.from('speaker,text,id\npeer,"hello,\nthere",0012345678901234567\nme,yes,00001'));
  expect(csv.rows[0]).toEqual({speaker:'peer',text:'hello,\nthere',id:'0012345678901234567'});
  expect(csv.rows[1]?.id).toBe('00001');
  expect((await parseDocument('hello.md',Buffer.from('# 说明\n你好'))).text).toContain('你好');
  await expect(parseDocument('bad.txt',Buffer.from([255,254,0]))).rejects.toThrow('KNOWLEDGE_UTF8_REQUIRED');
});
test('JSON and TXT pairing excludes unknown identity and group chats',async()=>{
  const parsed=await parseDocument('chat.txt',Buffer.from('客户:你好\n本人:你好呀\n客户:有现货吗\n本人:我查一下'));
  const mapping={speakerColumn:'speaker',textColumn:'text',selfName:'本人',channel:'DIRECT_MESSAGE' as const};
  expect(mapChat(parsed,mapping)).toHaveLength(2);
  expect(()=>mapChat(parsed,{...mapping,selfName:'不存在'})).toThrow('KNOWLEDGE_NO_PAIRED_SAMPLES');
  const group=await parseDocument('chat.jsonl',Buffer.from('{"speaker":"甲","text":"问"}\n{"speaker":"乙","text":"问"}\n{"speaker":"本人","text":"答"}'));
  expect(()=>mapChat(group,mapping)).toThrow('KNOWLEDGE_NO_PAIRED_SAMPLES');
  await expect(parseDocument('bad.json',Buffer.from('{}'))).rejects.toThrow('KNOWLEDGE_JSON_ARRAY_REQUIRED');
  await expect(parseDocument('large-id.json',Buffer.from('[{"speaker":9007199254740993,"text":"hi"}]'))).rejects.toThrow('KNOWLEDGE_JSON_UNSAFE_NUMBER');
  expect((await parseDocument('string-id.json',Buffer.from('[{"speaker":"9007199254740993","text":"hi"}]'))).rows[0]?.speaker).toBe('9007199254740993');
});
test('chat mapping sorts explicit timestamps, joins reply turns and never truncates overlong pairs',async()=>{
  const parsed=await parseDocument('chat.json',Buffer.from(JSON.stringify([
    {who:'我',body:'再补一句',at:'2026-11-16T12:00:02Z'},
    {who:'客户',body:'你好',at:'2026-11-16T12:00:00Z'},
    {who:'我',body:'你好呀',at:'2026-11-16T12:00:01Z'},
    {who:'客户',body:'长'.repeat(4001),at:'2026-11-16T12:00:03Z'},
    {who:'客户',body:'后续',at:'2026-11-16T12:00:04Z'},
    {who:'我',body:'这一组不能取末尾冒充完整问题',at:'2026-11-16T12:00:05Z'},
  ])));
  const mapping={speakerColumn:'who',textColumn:'body',selfName:'我',timeColumn:'at',channel:'DIRECT_MESSAGE' as const};
  const preview=mapChatPreview(parsed,mapping);expect(preview.pairs).toHaveLength(1);
  expect(preview.pairs[0]).toMatchObject({prompt:'你好',response:'你好呀\n再补一句'});
  expect(preview.warnings.join('')).toContain('1 组问答');
  expect(()=>mapChat(parsed,{...mapping,timeColumn:'missing'})).toThrow('KNOWLEDGE_MAPPING_REQUIRED');
  parsed.rows[0]!.at='11/16/26';expect(()=>mapChat(parsed,mapping)).toThrow('KNOWLEDGE_CHAT_TIME_INVALID');
});
test('DOCX extracts paragraphs without executing links or rendering HTML',async()=>{
  const bytes=zip({'[Content_Types].xml':'<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
    'word/document.xml':'<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>商品说明</w:t></w:r></w:p></w:body></w:document>'});
  expect((await parseDocument('test.docx',bytes)).text).toContain('商品说明');
  await expect(parseDocument('bad.docx',zip({'word/vbaProject.bin':'x'}))).rejects.toThrow('KNOWLEDGE_ACTIVE_CONTENT_UNSUPPORTED');
});
test('XLSX preserves ordinary cells and flags formulas without accepting cached values',async()=>{
  const book=new ExcelJS.Workbook(),sheet=book.addWorksheet('规格');sheet.addRow(['型号','库存']);
  sheet.addRow(['0001',{formula:'1+1',result:2}]);const bytes=await book.xlsx.writeBuffer();
  const parsed=await parseDocument('test.xlsx',Buffer.from(bytes));
  expect(parsed.rows[0]).toMatchObject({'型号':'0001','库存':''});expect(parsed.warnings.join('')).toContain('公式');
  const other=new ExcelJS.Workbook();other.addWorksheet('SheetName').addRows([['__sheet','text'],['OriginalValue','hello']]);
  const actual=await parseDocument('user-columns.xlsx',Buffer.from(await other.xlsx.writeBuffer()));
  expect(actual.rows[0]).toEqual({__sheet:'OriginalValue',text:'hello'});expect(actual.text).toContain('OriginalValue');
});
test('PDF text extraction runs from bytes, empty scans do not succeed',async()=>{
  const body='BT /F1 12 Tf 10 20 Td (hello knowledge) Tj ET';
  const pdf=`%PDF-1.4\n1 0 obj <</Type /Catalog /Pages 2 0 R>> endobj\n2 0 obj <</Type /Pages /Kids [3 0 R] /Count 1>> endobj\n3 0 obj <</Type /Page /Parent 2 0 R /MediaBox [0 0 200 100] /Resources <</Font <</F1 4 0 R>>>> /Contents 5 0 R>> endobj\n4 0 obj <</Type /Font /Subtype /Type1 /BaseFont /Helvetica>> endobj\n5 0 obj <</Length ${body.length}>> stream\n${body}\nendstream endobj\ntrailer <</Root 1 0 R>>\n%%EOF`;
  expect((await parseDocument('hello.pdf',Buffer.from(pdf))).text).toContain('hello knowledge');
});
test('bounded uploads enforce order, role preview, worker parsing and cleanup',async()=>{
  const base=resolve('.local/tests');await mkdir(base,{recursive:true});const root=await mkdtemp(join(base,'knowledge-import-'));roots.push(root);
  const imports=new KnowledgeImports(root),bytes=Buffer.from('客人:你好\n我:你好呀');
  try{
    const {id}=await imports.start('chat.txt',bytes.length,'CHAT');
    await expect(imports.chunk(id,1,bytes.toString('base64'))).rejects.toThrow('KNOWLEDGE_UPLOAD_ORDER');
    await imports.chunk(id,0,bytes.toString('base64'));
    const preview=await imports.finish(id);expect(preview.columns).toEqual(['speaker','text']);
    expect(imports.previewMapping(id,{speakerColumn:'speaker',textColumn:'text',selfName:'我',channel:'DIRECT_MESSAGE'}).total).toBe(1);
    await imports.cancel(id);expect(await readdir(join(root,'reply-imports'))).toEqual([]);
  }finally{await imports.close();}
});
test('concurrent upload starts reserve capacity before IO and reject wrong source formats',async()=>{
  const base=resolve('.local/tests');await mkdir(base,{recursive:true});const root=await mkdtemp(join(base,'knowledge-import-'));roots.push(root);
  const imports=new KnowledgeImports(root);
  try{
    await expect(imports.start('chat.pdf',10,'CHAT')).rejects.toThrow('KNOWLEDGE_FORMAT_UNSUPPORTED');
    const results=await Promise.allSettled(Array.from({length:6},()=>imports.start('source.txt',20*1024*1024,'KNOWLEDGE')));
    expect(results.filter(result=>result.status==='fulfilled')).toHaveLength(5);
    expect(results.filter(result=>result.status==='rejected')).toHaveLength(1);
  }finally{await imports.close();}
  expect(await readdir(join(root,'reply-imports'))).toEqual([]);
});
test('shutdown can stop a parser before draining commands and then remove the upload',async()=>{
  const base=resolve('.local/tests');await mkdir(base,{recursive:true});const root=await mkdtemp(join(base,'knowledge-import-'));roots.push(root);
  const imports=new KnowledgeImports(root),bytes=Buffer.from('hello knowledge');
  const {id}=await imports.start('source.txt',bytes.length,'KNOWLEDGE');await imports.chunk(id,0,bytes.toString('base64'));
  const result=imports.finish(id).then(()=>null,error=>error);
  await imports.cancelActiveParse();expect((await result).message).toBe('KNOWLEDGE_PARSE_CANCELLED');
  await imports.close();expect(await readdir(join(root,'reply-imports'))).toEqual([]);
});
