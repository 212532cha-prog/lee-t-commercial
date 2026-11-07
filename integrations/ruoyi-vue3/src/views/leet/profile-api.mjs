import { createAdminTransport } from './warehouse-api.mjs';

export function createProfileClient(options = {}) {
  const { read, write } = createAdminTransport(options);
  return {
    async get(signal) { return (await read('/api/profile', { signal })).user; },
    save(realName, expectedVersion) { return write('/api/profile', { method:'PATCH',data:{realName,expectedVersion} }); },
    avatar(file) { return write('/api/me/avatar', { method:'PUT',raw:file,headers:{'Content-Type':file.type} }); },
    removeAvatar() { return write('/api/me/avatar', { method:'DELETE' }); },
    password(oldPassword,newPassword) { return write('/api/me/password', { method:'POST',data:{oldPassword,newPassword} }); },
  };
}
