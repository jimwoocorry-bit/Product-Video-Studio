import fs from 'node:fs/promises';
import path from 'node:path';

/** The container-wide flock must be owned before touching Chromium's transient
 * singleton symlinks. Persistent profile contents are never removed. */
export async function recoverProfileLocks(profile,{exclusiveLockHeld=false}={}) {
  if(!exclusiveLockHeld)throw Error('Exclusive runtime lock is required');
  const info=await fs.lstat(profile);
  if(!info.isDirectory()||info.isSymbolicLink())throw Error('Browser profile must not be a symlink');
  const root=await fs.realpath(profile);
  for(const name of ['SingletonLock','SingletonCookie','SingletonSocket']) {
    const filename=path.join(root,name);
    try{
      const info=await fs.lstat(filename);
      if(!info.isSymbolicLink())throw Error('Unexpected browser lock file; refusing to remove it');
      await fs.unlink(filename);
    }catch(error){if(error.code!=='ENOENT')throw error;}
  }
}
