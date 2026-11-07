import { createAdminTransport } from './warehouse-api.mjs';

export function createBackupClient(options = {}) {
  const { read, write } = createAdminTransport({timeoutMs:600000,...options});
  return {
    list(signal) { return read('/api/backups',{signal}); },
    configure(data) { return write('/api/backups/config',{method:'PUT',data}); },
    create() { return write('/api/backups',{method:'POST',data:{}}); },
    remove(id) { return write('/api/backups/'+encodeURIComponent(id),{method:'DELETE'}); },
    maintenance(enabled) { return write('/api/maintenance',{method:'PUT',data:{enabled,confirm:'change-maintenance'}}); },
    upload(file) { return write('/api/backups/upload',{method:'POST',raw:file,headers:{'Content-Type':'application/octet-stream'}}); },
    cleanUploads() { return write('/api/backups/uploads',{method:'DELETE'}); },
    restore(id,uploaded) { return write('/api/backups/restore',{method:'POST',data:{id,uploaded,confirm:'restore-entire-system'}}); },
  };
}
