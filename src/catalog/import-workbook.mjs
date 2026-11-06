import {buffer} from 'node:stream/consumers';
import {readSheet} from 'read-excel-file/node';
import {Parser} from 'saxen';
import yauzl from 'yauzl';
import yazl from 'yazl';
import {AuthError} from '../auth/service.mjs';

export const workbookType='application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
export const workbookLimit=1024*1024;
const expandedLimit=4*workbookLimit;
const headers=['Name','Unit cost (RM)','Minimum stock'];

function checkXml(contents){
 const parser=new Parser();
 let inSheetData=false;
 parser.on('closeTag',tag=>{if(tag.split(':').at(-1)==='sheetData')inSheetData=false;});
 parser.on('error',error=>{throw error;});
 parser.on('openTag',(tag,attrs,decode)=>{
  const local=tag.split(':').at(-1);
  if(local==='sheetData')inSheetData=true;
  if(!inSheetData)return;
  if(local==='f')throw new AuthError('IMPORT_FORMULA_NOT_ALLOWED');
  if(local!=='row'&&local!=='c')return;
  const ref=decode(attrs().r||'');
  const pattern=local==='row'?/^([1-9]\d{0,2})$/:/^[A-C]([1-9]\d{0,2})$/;
  const match=pattern.exec(ref);
  if(!match||Number(match[1])>201)throw new AuthError('IMPORT_SHEET_LIMIT');
 });
 parser.parse(contents.toString('utf8'));
}

async function sanitizedArchive(input){
 const zip=await yauzl.fromBufferPromise(input,{lazyEntries:true});
 try{
  if(zip.entryCount>80)throw new AuthError('IMPORT_SHEET_LIMIT');
  const clean=new yazl.ZipFile(),names=new Set();
  let size=0;
  for await(const entry of zip.eachEntry()){
   if(!/\.(xml|rels)$/.test(entry.fileName))continue;
   size+=entry.uncompressedSize;
   if(size>expandedLimit||names.has(entry.fileName))throw new AuthError('IMPORT_SHEET_LIMIT');
   names.add(entry.fileName);
   const contents=await buffer(await zip.openReadStreamPromise(entry));
   checkXml(contents);
   clean.addBuffer(contents,entry.fileName);
  }
  clean.end();
  return await buffer(clean.outputStream);
 }finally{zip.close();}
}

export async function readProductWorkbook(input){
 let sheet;
 try{sheet=await readSheet(await sanitizedArchive(input),'Products',{parseNumber:value=>value});}
 catch(error){if(error instanceof AuthError)throw error;throw new AuthError('INVALID_PRODUCT_WORKBOOK');}
 const header=sheet.shift();
 if(header?.length!==headers.length||headers.some((value,index)=>header[index]!==value))throw new AuthError('INVALID_IMPORT_HEADERS');
 return sheet.map(([name,individualCost,minimumStock],index)=>({row:index+2,name,individualCost,minimumStock}))
  .filter(({name,individualCost,minimumStock})=>[name,individualCost,minimumStock].some(value=>value!==null&&value!==undefined));
}

export async function productWorkbookTemplate(){
 const main='http://schemas.openxmlformats.org/spreadsheetml/2006/main';
 const rel='http://schemas.openxmlformats.org/officeDocument/2006/relationships';
 const relationships=(type,target)=>`<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${rel}/${type}" Target="${target}"/></Relationships>`;
 const zip=new yazl.ZipFile();
 for(const [path,xml] of [
  ['[Content_Types].xml','<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>'],
  ['_rels/.rels',relationships('officeDocument','xl/workbook.xml')],
  ['xl/workbook.xml',`<workbook xmlns="${main}" xmlns:r="${rel}"><sheets><sheet name="Products" sheetId="1" r:id="rId1"/></sheets></workbook>`],
  ['xl/_rels/workbook.xml.rels',relationships('worksheet','worksheets/sheet1.xml')],
  ['xl/worksheets/sheet1.xml',`<worksheet xmlns="${main}"><sheetData><row r="1">${headers.map((header,i)=>`<c r="${'ABC'[i]}1" t="inlineStr"><is><t>${header}</t></is></c>`).join('')}</row></sheetData></worksheet>`]
 ])zip.addBuffer(Buffer.from(xml),path);
 zip.end();
 return buffer(zip.outputStream);
}
