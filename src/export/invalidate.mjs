// Call inside the same transaction that removes source data. No business snapshots are retained.
export async function invalidateExports(db,{productId,eventIds,reportIds}){
 let sql,args;
 if(productId){sql='SELECT DISTINCT j.id,j.format FROM export_jobs j JOIN export_resources r ON r.job_id=j.id WHERE r.product_id=$1';args=[productId];}
 else if(eventIds){sql='SELECT DISTINCT j.id,j.format FROM export_jobs j JOIN export_history_resources r ON r.job_id=j.id WHERE r.event_id=ANY($1::bigint[])';args=[eventIds];}
 else if(reportIds){sql='SELECT DISTINCT j.id,j.format FROM export_jobs j JOIN export_report_resources r ON r.job_id=j.id WHERE r.report_id=ANY($1::uuid[])';args=[reportIds];}
 else return;
 const rows=(await db.query(sql+' ORDER BY j.id',args)).rows;
 for(const job of rows){for(const extension of [job.format,'partial','spool','work'])await db.query("INSERT INTO file_cleanup(file_key,asset_kind) VALUES($1,'export') ON CONFLICT DO NOTHING",[job.id+'.'+extension]);await db.query('DELETE FROM export_jobs WHERE id=$1',[job.id]);}
}
