import { readFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';

const types = {
  html: 'text/html; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  css: 'text/css; charset=utf-8',
};

export function createRuoyiStatic(directory) {
  if (!isAbsolute(directory)) throw Error('RUOYI_ADMIN_DIRECTORY_MUST_BE_ABSOLUTE');
  return async (req, res, path) => {
    if (!['GET', 'HEAD'].includes(req.method)) return false;
    const index = path === '/admin/' || path === '/admin';
    const asset = /^\/admin\/(static\/(?:css|js)\/[\w-]+\.(?:css|js))$/.exec(path);
    if (!index && !asset) return false;
    const name = index ? 'index.html' : asset[1];
    let content;
    try { content = await readFile(join(directory, name)); }
    catch (error) {
      if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return false;
      throw error;
    }
    res.writeHead(200, { 'Content-Type': types[name.split('.').at(-1)], 'Content-Length': content.length });
    res.end(req.method === 'HEAD' ? undefined : content);
    return true;
  };
}
