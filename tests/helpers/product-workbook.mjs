import {buffer} from 'node:stream/consumers';
import yauzl from 'yauzl';
import yazl from 'yazl';
import {productWorkbookTemplate} from '../../src/catalog/import-workbook.mjs';

export async function workbookWithRows(rows){
 const input=await yauzl.fromBufferPromise(await productWorkbookTemplate(),{lazyEntries:true});
 const output=new yazl.ZipFile();
 for await(const entry of input.eachEntry()){
  let contents=await buffer(await input.openReadStreamPromise(entry));
  if(entry.fileName==='xl/worksheets/sheet1.xml')contents=Buffer.from(contents.toString().replace('</sheetData>',rows+'</sheetData>'));
  output.addBuffer(contents,entry.fileName);
 }
 output.end();
 return buffer(output.outputStream);
}
export function productRow(index,name,cost,minimum){
 return `<row r="${index}"><c r="A${index}" t="inlineStr"><is><t>${name}</t></is></c><c r="B${index}"><v>${cost}</v></c><c r="C${index}"><v>${minimum}</v></c></row>`;
}
