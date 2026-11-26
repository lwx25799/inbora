import {Readable} from 'node:stream';
import {extname} from 'node:path';
import {requireSafe} from '../core/contracts.js';

export interface ParsedDocument {text:string;rows:Record<string,string>[];columns:string[];warnings:string[]}
const maximumText=4_000_000,maximumRows=100_000;
function bounded(text:string):string {requireSafe(text.length<=maximumText,'KNOWLEDGE_TEXT_TOO_LARGE');return text;}
function zipCheck(bytes:Buffer):void {
  let total=0,count=0;
  for(let i=0;i+46<=bytes.length;i++)if(bytes.readUInt32LE(i)===0x02014b50){
    const nameLength=bytes.readUInt16LE(i+28),extra=bytes.readUInt16LE(i+30),comment=bytes.readUInt16LE(i+32);
    const name=bytes.subarray(i+46,i+46+nameLength).toString('utf8');
    requireSafe(!/vbaProject|macros|externalLinks/iu.test(name),'KNOWLEDGE_ACTIVE_CONTENT_UNSUPPORTED');
    total+=bytes.readUInt32LE(i+24);count++;
    requireSafe(total<=100*1024*1024&&count<=10000,'KNOWLEDGE_ARCHIVE_TOO_LARGE');i+=45+nameLength+extra+comment;
  }
  requireSafe(count>0,'KNOWLEDGE_INVALID_ARCHIVE');
}
function records(raw:unknown[]):Record<string,string>[] {
  requireSafe(raw.length<=maximumRows,'KNOWLEDGE_TOO_MANY_ROWS');
  return raw.map(value=>{
    requireSafe(value!==null&&typeof value==='object'&&!Array.isArray(value),'KNOWLEDGE_INVALID_CHAT_ROWS');
    const pairs=Object.entries(value).filter(([,v])=>typeof v==='string'||typeof v==='number'||typeof v==='boolean'||v===null);
    requireSafe(pairs.length<=100,'KNOWLEDGE_TOO_MANY_COLUMNS');
    requireSafe(pairs.every(([,v])=>typeof v!=='number'||!Number.isInteger(v)||Number.isSafeInteger(v)),'KNOWLEDGE_JSON_UNSAFE_NUMBER');
    return Object.fromEntries(pairs.map(([key,v])=>[key,String(v??'')]));
  });
}
export async function parseDocument(name:string,bytes:Buffer):Promise<ParsedDocument>{
  const extension=extname(name).toLowerCase(),warnings:string[]=[];
  let text='',rows:Record<string,string>[]=[];
  if(['.txt','.md','.json','.jsonl','.csv'].includes(extension)){
    try{text=new TextDecoder('utf-8',{fatal:true}).decode(bytes).replace(/^\uFEFF/u,'');}
    catch{requireSafe(false,'KNOWLEDGE_UTF8_REQUIRED');}
    bounded(text);
    if(extension==='.json'||extension==='.jsonl'){
      let parsed:unknown;try{parsed=extension==='.json'?JSON.parse(text):text.split(/\r?\n/u).filter(line=>line.trim()).map(line=>JSON.parse(line));}
      catch{requireSafe(false,'KNOWLEDGE_INVALID_JSON');}
      requireSafe(Array.isArray(parsed),'KNOWLEDGE_JSON_ARRAY_REQUIRED');rows=records(parsed);
    }else if(extension==='.txt'){
      rows=text.split(/\r?\n/u).filter(line=>line.trim()).map(line=>{
        const match=/^([^:：\r\n]{1,100})[:：]\s*(.*)$/u.exec(line);
        return match?{speaker:match[1]!,text:match[2]!}:{speaker:'',text:line};
      });
    }else if(extension==='.csv'){
      const {default:ExcelJS}=await import('exceljs');const workbook=new ExcelJS.Workbook();
      const sheet=await workbook.csv.read(Readable.from([text]),{map:value=>String(value)});
      rows=sheetRecords(sheet,warnings);
    }
  }else if(extension==='.docx'){
    zipCheck(bytes);const mammoth=await import('mammoth');
    const result=await mammoth.extractRawText({buffer:bytes});text=result.value;
    if(result.messages.length)warnings.push('文档有解析提示，请核对提取的段落。');
  }else if(extension==='.xlsx'){
    zipCheck(bytes);const {default:ExcelJS}=await import('exceljs');const workbook=new ExcelJS.Workbook();
    await workbook.xlsx.load(bytes as never);
    for(const sheet of workbook.worksheets){
      const part=sheetRecords(sheet,warnings);rows.push(...part);
      text+=`\n工作表：${sheet.name}\n${part.map(row=>Object.entries(row).map(([key,value])=>`${key}: ${value}`).join('；')).join('\n')}\n`;
      bounded(text);
    }
  }else if(extension==='.pdf'){
    const {getDocument}=await import('pdfjs-dist/legacy/build/pdf.mjs');
    const loading=getDocument({data:new Uint8Array(bytes),useSystemFonts:false,disableFontFace:true});
    try{
      const pdf=await loading.promise;requireSafe(pdf.numPages<=500,'KNOWLEDGE_TOO_MANY_PAGES');
      for(let page=1;page<=pdf.numPages;page++){
        const content=await (await pdf.getPage(page)).getTextContent();
        const body=content.items.map(item=>'str'in item?item.str+('hasEOL'in item&&item.hasEOL?'\n':' '):'').join('');
        if(body.trim())text+=`\n第 ${page} 页\n${body}\n`;bounded(text);
      }
    }finally{await loading.destroy();}
    warnings.push('PDF 多栏或表格的阅读顺序可能变化，请核对预览。');
  }else requireSafe(false,'KNOWLEDGE_FORMAT_UNSUPPORTED');
  requireSafe(rows.length<=maximumRows,'KNOWLEDGE_TOO_MANY_ROWS');bounded(text);
  requireSafe(text.trim().length>0||rows.length>0,'KNOWLEDGE_NO_TEXT');
  const columns=[...new Set(rows.flatMap(row=>Object.keys(row)))];
  requireSafe(columns.length<=100,'KNOWLEDGE_TOO_MANY_COLUMNS');
  return {text,rows,columns,warnings:[...new Set(warnings)]};
}
function sheetRecords(sheet:import('exceljs').Worksheet,warnings:string[]):Record<string,string>[] {
  requireSafe(sheet.rowCount<=maximumRows+1&&sheet.columnCount<=100,'KNOWLEDGE_TABLE_TOO_LARGE');
  const cellText=(cell:import('exceljs').Cell)=>{
    if(cell.type===6){warnings.push('公式单元格已留空；请用已确认的固定值替换后再导入。');return '';}
    if(cell.value instanceof Date)return cell.value.toISOString();
    return cell.text;
  };
  const headers:Array<string>=[];sheet.getRow(1).eachCell({includeEmpty:true},(cell,index)=>headers[index-1]=cellText(cell)||`列${index}`);
  requireSafe(new Set(headers).size===headers.length,'KNOWLEDGE_DUPLICATE_COLUMNS');
  const result:Record<string,string>[]=[];
  sheet.eachRow((row,index)=>{if(index>1)result.push(Object.fromEntries(headers.map((header,i)=>[header,cellText(row.getCell(i+1))])));});
  return result;
}
