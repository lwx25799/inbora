/** Independent minimal protobuf fixture builder, never imported by product code. */
export function vi(value:number|bigint):Buffer{
  let n=BigInt(value);const out:number[]=[];do{let b=Number(n&127n);n>>=7n;if(n)b|=128;out.push(b);}while(n);return Buffer.from(out);
}
export function int(tag:number,value:number|bigint):Buffer{return Buffer.concat([vi(tag*8),vi(value)]);}
export function str(tag:number,value:string|Buffer):Buffer{const b=Buffer.isBuffer(value)?value:Buffer.from(value);return Buffer.concat([vi(tag*8+2),vi(b.length),b]);}
export function dmRequest(text:string,conversation='conv-a',client='synthetic-client'):Buffer{
  return Buffer.concat([int(1,100),int(2,99),str(8,str(100,Buffer.concat([str(1,conversation),int(2,1),str(4,JSON.stringify({text})),int(6,7),str(8,client)])))]);
}
export function dmResponse(overrides:{id?:bigint;client?:string;status?:number;sequence?:number;owner?:number;async?:boolean;check?:number}={}):Buffer{
  return Buffer.concat([int(1,100),int(2,overrides.sequence??99),int(3,0),int(13,overrides.owner??100),str(6,str(100,Buffer.concat([
    int(1,overrides.id??801n),int(3,overrides.status??0),str(4,overrides.client??'synthetic-client'),int(5,overrides.check??0),int(8,overrides.async?1:0)])))]);
}
