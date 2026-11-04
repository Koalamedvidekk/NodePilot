import { createHash, randomUUID } from 'node:crypto';
import { constants, createReadStream } from 'node:fs';
import { copyFile, lstat, mkdir, open, readdir, realpath, rename, rm, statfs } from 'node:fs/promises';
import path from 'node:path';

import type { SqliteDatabase } from '../db.js';
import { AppError, errorMessage } from '../lib/errors.js';
import { isInside, resolveManagedServerRoot } from '../lib/paths.js';
import { AddonPendingRepository, type AddonChangeJournal, type PendingAddonChange, type PendingAddonRecord } from '../repositories/addon-pending-repository.js';
import { ServerRepository } from '../repositories/server-repository.js';
import { addonCompatibility, safeAddonFileName, type AddonRecord, type AddonSource, type AddonType } from './addon-service.js';
import { inspectJar } from './jar-inspection.js';
import type { ServerRecord } from '../types.js';

export type AddonChangeOptions = {
  dataDirectory?: string;
  getServer?: (id:string)=>ServerRecord|null|undefined;
  isProcessActive?: (id:string)=>boolean;
  assertCanMutate?: (id:string)=>void;
};
export type AddonMutationResult = { addon?:AddonRecord; backup?:string; queued:boolean; pendingChange?:PendingAddonChange };
const LIMIT=256*1024*1024;
const key=(type:AddonType,file:string)=>type+'/'+file.normalize('NFKC').toLowerCase();
const publicChange=({software:_software,minecraftVersion:_minecraftVersion,artifactHash:_artifactHash,versionId:_versionId,baseline:_baseline,...change}:PendingAddonRecord):PendingAddonChange=>change;
const active=(server:ServerRecord)=>['running','starting','stopping'].includes(server.status);

async function present(file:string):Promise<boolean>{return lstat(file).then(()=>true,(error:NodeJS.ErrnoException)=>{if(error.code==='ENOENT')return false;throw error;});}
async function hashFile(file:string):Promise<string>{
  const info=await lstat(file);
  if(!info.isFile()||info.isSymbolicLink()||info.size>LIMIT)throw new AppError(409,'unsafe_addon_file','Add-on changes require regular JAR files no larger than 256 MB.');
  const hash=createHash('sha256');for await(const chunk of createReadStream(file))hash.update(chunk);return hash.digest('hex');
}
async function syncFile(file:string):Promise<void>{const handle=await open(file,process.platform==='win32'?'r+':'r');try{await handle.sync();}finally{await handle.close();}}

/** A configured storage root may be an alias; paths beneath it may never be links. */
async function safePath(root:string,relative:string,missing=false):Promise<string>{
  if(!relative||relative.startsWith('/')||/^[a-z]:/i.test(relative)||relative.includes('\\')||/[\x00-\x1f\x7f]/.test(relative)||relative.split('/').some(part=>!part||part==='.'||part==='..'))throw new AppError(409,'unsafe_addon_path','An add-on path is invalid.');
  const base=await realpath(root);let result=base;
  for(const part of relative.split('/')){
    result=path.join(result,part);
    try{const info=await lstat(result);if(info.isSymbolicLink()||!info.isDirectory()&&!info.isFile()||!isInside(base,await realpath(result)))throw new AppError(409,'unsafe_addon_path','Add-on operations refuse linked or special paths.');}
    catch(error){if(!missing||(error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
  }
  if(!isInside(base,result)||result===base)throw new AppError(409,'unsafe_addon_path','An add-on path escapes its storage root.');return result;
}

/** Persistent stopped-before-launch changes. Running JVM files are never touched. */
export class AddonChangeService {
  private readonly pending:AddonPendingRepository;
  private readonly servers:ServerRepository;
  private readonly busy=new Set<string>();
  private readonly tasks=new Set<Promise<unknown>>();
  private stopping=false;
  private readonly dataDirectory:string;
  constructor(private readonly serversDirectory:string,private readonly backupsDirectory:string,private readonly database:SqliteDatabase,private readonly options:AddonChangeOptions={}){
    this.pending=new AddonPendingRepository(database);this.servers=new ServerRepository(database);
    this.dataDirectory=options.dataDirectory??path.dirname(path.resolve(backupsDirectory));
  }
  current(server:ServerRecord):ServerRecord {
    const latest=this.options.getServer?this.options.getServer(server.id):this.servers.find(server.id);
    if(!latest)throw new AppError(404,'server_not_found','This server no longer exists.');return latest;
  }
  isBusy(id:string):boolean{return this.busy.has(id);}
  anyBusy():boolean{return this.busy.size>0;}
  hasPending(id:string):boolean{return this.pending.list(id).length>0;}
  hasRecoveryBlock(id:string):boolean{return this.pending.journal(id)!==null;}
  list(id:string):PendingAddonChange[]{return this.pending.list(id).map(publicChange);}
  pendingError(id:string):string|null{return this.pending.journal(id)?.error??this.pending.list(id).find(change=>change.error)?.error??null;}
  capabilities(server:ServerRecord):{canMutate:boolean;mutationMessage?:string}{
    try{this.assertMutable(this.current(server));return{canMutate:true};}catch(error){return{canMutate:false,mutationMessage:errorMessage(error)};}
  }
  private assertMutable(server:ServerRecord):void{
    if(this.stopping)throw new AppError(409,'addon_shutdown','NodePilot is shutting down.');
    if(this.isBusy(server.id))throw new AppError(409,'addon_change_in_progress','Wait for the current add-on operation to finish.');
    if(this.hasRecoveryBlock(server.id))throw new AppError(409,'addon_recovery_required','An interrupted add-on change needs recovery. Restart NodePilot to retry recovery before changing or starting this server.');
    if(['starting','stopping','installing'].includes(server.status)||server.installState!=='ready')throw new AppError(409,'server_changing_state','Wait until the server finishes starting, stopping, or installing before changing add-ons.');
    this.options.assertCanMutate?.(server.id);
  }
  private async owned<T>(id:string,work:()=>Promise<T>):Promise<T>{
    if(this.busy.has(id))throw new AppError(409,'addon_change_in_progress','Wait for the current add-on operation to finish.');
    this.busy.add(id);
    const task=Promise.resolve().then(work);this.tasks.add(task);
    try{return await task;}finally{this.tasks.delete(task);this.busy.delete(id);}
  }
  async mutate<T>(server:ServerRecord,work:(current:ServerRecord)=>Promise<T>):Promise<T>{
    const current=this.current(server);this.assertMutable(current);return this.owned(server.id,()=>work(current));
  }
  async stop():Promise<void>{this.stopping=true;await Promise.allSettled([...this.tasks]);}
  private async storage(relative:string,createParent=false):Promise<string>{
    await mkdir(this.dataDirectory,{recursive:true});
    const root=await safePath(this.dataDirectory,'addon-changes',true);await mkdir(root,{recursive:true,mode:0o700});
    const target=await safePath(root,relative,true);if(createParent)await mkdir(path.dirname(target),{recursive:true,mode:0o700});
    return safePath(root,relative,true);
  }
  async stageDirectory():Promise<string>{
    const directory=await this.storage('staging/'+randomUUID()+'/marker',true);return path.dirname(directory);
  }
  async removeStage(directory:string):Promise<void>{
    const base=await this.storage('staging',false);
    const canonical=await realpath(directory).catch(()=>null);
    if(canonical&&isInside(base,canonical)&&canonical!==base)await rm(canonical,{recursive:true,force:true});
  }
  private async directory(server:ServerRecord,type:AddonType,create=false):Promise<string>{
    const root=await resolveManagedServerRoot(this.serversDirectory,server.directory);
    const folder=type==='plugin'?'plugins':'mods';
    const directory=await safePath(root,folder,true);
    if(create)await mkdir(directory,{recursive:true});
    if(await present(directory)){const info=await lstat(directory);if(!info.isDirectory()||info.isSymbolicLink())throw new AppError(409,'unsafe_addon_directory','The add-on directory is linked or invalid.');}
    return directory;
  }
  private async target(server:ServerRecord,type:AddonType,fileName:string):Promise<{fileName:string;file:string;hash:string|null}>{
    const name=safeAddonFileName(fileName),directory=await this.directory(server,type);
    const aliases=(await readdir(directory).catch((error:NodeJS.ErrnoException)=>{if(error.code==='ENOENT')return[];throw error;})).filter(entry=>entry.normalize('NFKC').toLowerCase()===name.toLowerCase());
    if(aliases.length>1)throw new AppError(409,'addon_name_collision','Add-on names collide on Windows. Resolve the duplicate names before continuing.');
    const actual=aliases[0]??name;
    if(safeAddonFileName(actual)!==actual)throw new AppError(409,'unsafe_addon_filename','An existing add-on filename cannot be changed safely.');
    const file=path.join(directory,actual);return{fileName:actual,file,hash:await present(file)?await hashFile(file):null};
  }
  private assertUnchanged(server:ServerRecord,latest:ServerRecord):void{
    if(server.software!==latest.software||server.version!==latest.version||server.directory!==latest.directory)throw new AppError(409,'addon_server_changed','The server software or Minecraft version changed. Refresh and select a compatible add-on again.');
    if(['starting','stopping','installing'].includes(latest.status)||latest.installState!=='ready')throw new AppError(409,'server_changing_state','Wait until the server finishes changing state before adding this change.');
  }
  private rejectOverlap(serverId:string,type:AddonType,names:string[],projectId?:string,source?:AddonSource):void{
    const conflict=this.pending.list(serverId).find(change=>change.type===type&&(names.some(name=>[change.fileName,change.originalFileName].filter(Boolean).some(other=>key(type,other!)===key(type,name)))||projectId&&change.projectId===projectId&&change.source===source));
    if(conflict)throw new AppError(409,'addon_change_already_queued','This add-on already has a queued change. Cancel that change before replacing it.');
    if(this.pending.list(serverId).length>=128)throw new AppError(413,'addon_queue_full','At most 128 add-on changes may be queued for one server.');
  }
  async submit(server:ServerRecord,type:AddonType,stagedPath:string,fileName:string,source:AddonSource,projectId?:string,versionId?:string,originalFileName?:string):Promise<AddonMutationResult>{
    const latest=this.current(server);this.assertUnchanged(server,latest);
    const metadata=await inspectJar(stagedPath);
    const compatibility=addonCompatibility(type,latest,metadata);
    if(!compatibility.compatible)throw new AppError(422,'addon_incompatible',compatibility.message??'This add-on is not compatible with this server.');
    const artifactHash=await hashFile(stagedPath);
    const target=await this.target(latest,type,fileName);
    const original=originalFileName?await this.target(latest,type,originalFileName):null;
    if(original&&original.hash===null)throw new AppError(409,'addon_changed','The installed add-on disappeared while its update was downloading. Refresh before retrying.');
    this.rejectOverlap(latest.id,type,[target.fileName,...(original?[original.fileName]:[])],projectId,source);
    const baseline:Record<string,string|null>={[target.fileName]:target.hash};
    if(original)baseline[original.fileName]=original.hash;
    const change:PendingAddonRecord={id:randomUUID(),serverId:latest.id,type,fileName:target.fileName,
      originalFileName:original&&key(type,original.fileName)!==key(type,target.fileName)?original.fileName:undefined,
      action:original||target.hash?'update':'install',name:metadata.name,version:metadata.version,source,projectId,createdAt:new Date().toISOString(),error:null,
      software:latest.software,minecraftVersion:latest.version,artifactHash,versionId,baseline};
    const artifact=await this.storage('artifacts/'+change.id+'.jar',true);
    try{
      await copyFile(stagedPath,artifact,constants.COPYFILE_EXCL);await syncFile(artifact);
      if(await hashFile(artifact)!==artifactHash)throw new AppError(409,'addon_staged_file_changed','The uploaded JAR changed while it was being staged. Retry the upload.');
      this.pending.save(change);
    }catch(error){await rm(artifact,{force:true}).catch(()=>undefined);throw error;}
    const queued=active(latest)||Boolean(this.options.isProcessActive?.(latest.id))||this.pending.list(latest.id).length>1;
    const details=await lstat(artifact);
    const addon:AddonRecord={type,fileName:change.fileName,size:details.size,modifiedAt:details.mtime.toISOString(),source,projectId,versionId,
      metadata:{name:metadata.name,version:metadata.version,software:metadata.software,apiVersion:metadata.apiVersion,loader:metadata.loader},compatible:true};
    if(queued)return{addon,queued:true,pendingChange:publicChange(change)};
    const backup=await this.applyLocked(latest);
    return{addon,queued:false,backup};
  }
  async remove(server:ServerRecord,type:AddonType,fileName:string):Promise<AddonMutationResult>{
    const latest=this.current(server);this.assertUnchanged(server,latest);
    const target=await this.target(latest,type,fileName);
    if(!target.hash)throw new AppError(404,'addon_not_found','That installed add-on no longer exists.');
    this.rejectOverlap(latest.id,type,[target.fileName]);
    const row=this.database.prepare('SELECT source,project_id FROM addon_installs WHERE server_id=? AND addon_type=? AND file_name=?').get(server.id,type,target.fileName) as {source:AddonSource;project_id:string|null}|undefined;
    const change:PendingAddonRecord={id:randomUUID(),serverId:latest.id,type,fileName:target.fileName,action:'remove',source:row?.source??'import',projectId:row?.project_id??undefined,
      createdAt:new Date().toISOString(),error:null,software:latest.software,minecraftVersion:latest.version,baseline:{[target.fileName]:target.hash}};
    this.pending.save(change);
    if(active(latest)||this.options.isProcessActive?.(latest.id)||this.pending.list(latest.id).length>1)return{queued:true,pendingChange:publicChange(change)};
    return{queued:false,backup:await this.applyLocked(latest)};
  }
  async cancelPending(server:ServerRecord,id:string):Promise<void>{
    return this.mutate(server,async()=>{
      if(!/^[a-f0-9-]{36}$/i.test(id))throw new AppError(400,'invalid_addon_change','Invalid queued change identifier.');
      const change=this.pending.list(server.id).find(value=>value.id===id);
      if(!change)throw new AppError(404,'addon_change_not_found','This queued change no longer exists.');
      this.pending.remove(server.id,id);
      if(change.artifactHash){const artifact=await this.storage('artifacts/'+id+'.jar');await rm(artifact,{force:true}).catch(()=>undefined);}
    });
  }
  /** Called only after the stopped server's directory has been deleted. */
  async discardForDeletedServer(server:ServerRecord):Promise<void>{
    if(this.stopping||this.isBusy(server.id)||this.hasRecoveryBlock(server.id))throw new AppError(409,'addon_change_in_progress','Finish add-on changes or recovery before deleting this server.');
    if(this.options.isProcessActive?.(server.id))throw new AppError(409,'server_active','Stop the server before deleting its queued add-ons.');
    await this.owned(server.id,async()=>{
      for(const change of this.pending.list(server.id)){
        if(change.artifactHash)await rm(await this.storage('artifacts/'+change.id+'.jar'),{force:true});
        this.pending.remove(server.id,change.id);
      }
    });
  }
  async applyPending(server:ServerRecord):Promise<void>{
    if(this.stopping)throw new AppError(409,'addon_shutdown','NodePilot is shutting down.');
    if(!this.hasPending(server.id)&&!this.hasRecoveryBlock(server.id))return;
    await this.owned(server.id,async()=>{await this.applyLocked(this.current(server));});
  }
  private assertStopped(server:ServerRecord):void{
    if(['running','stopping','installing'].includes(server.status)||this.options.isProcessActive?.(server.id))throw new AppError(409,'server_active','Queued add-ons can only be applied before the Minecraft process starts.');
    if(server.installState!=='ready')throw new AppError(409,'server_not_ready','Repair the server installation before applying queued add-ons.');
  }
  private async ensureSpace(directory:string,bytes:number):Promise<void>{
    await mkdir(directory,{recursive:true});const info=await statfs(directory);
    if(Number(info.bavail)*Number(info.bsize)<bytes+32*1024*1024)throw new AppError(507,'insufficient_disk_space','Not enough free space to back up and apply queued add-ons. Free disk space and start again, or cancel the queued change.');
  }
  private async backupRoot(journal:AddonChangeJournal,create=false):Promise<string>{
    if(!/^[A-Za-z0-9_-]{1,96}$/.test(journal.serverId)||!/^[a-f0-9-]{36}$/i.test(journal.id))throw new AppError(409,'unsafe_addon_journal','The add-on recovery journal contains an invalid identity.');
    await mkdir(this.backupsDirectory,{recursive:true});
    const directory=await safePath(this.backupsDirectory,journal.serverId+'/addon-changes/'+journal.id,true);
    if(create)await mkdir(directory,{recursive:true,mode:0o700});return directory;
  }
  private async applyLocked(server:ServerRecord):Promise<string|undefined>{
    this.assertStopped(server);
    if(this.hasRecoveryBlock(server.id))throw new AppError(409,'addon_recovery_required','An interrupted add-on change needs recovery. Restart NodePilot to retry it.');
    const changes=this.pending.list(server.id);if(!changes.length)return;
    let journal:AddonChangeJournal|null=null;
    try{
      const targets=new Map<string,{type:AddonType;fileName:string;beforeHash:string|null;afterHash:string|null}>();
      let bytes=0;
      for(const change of changes){
        if(change.serverId!==server.id||change.software!==server.software||change.minecraftVersion!==server.version)throw new AppError(409,'addon_queue_incompatible','Queued add-ons were selected for a different Minecraft version or server software. Cancel the affected changes and choose compatible files before starting.');
        for(const [fileName,expected]of Object.entries(change.baseline)){
          const target=await this.target(server,change.type,fileName);
          if(target.fileName!==fileName||target.hash!==expected)throw new AppError(409,'addon_changed','An installed JAR changed after this add-on was queued. Cancel the queued change and review the installed files before starting.');
          const targetKey=key(change.type,fileName);
          if(targets.has(targetKey))throw new AppError(409,'addon_queue_conflict','Queued changes overlap. Cancel conflicting changes before starting.');
          targets.set(targetKey,{type:change.type,fileName,beforeHash:expected,afterHash:change.action==='remove'||fileName===change.originalFileName?null:change.artifactHash??null});
          if(expected)bytes+=(await lstat(target.file)).size;
        }
        if(change.action!=='remove'){
          const artifact=await this.storage('artifacts/'+change.id+'.jar');
          if(!change.artifactHash||await hashFile(artifact)!==change.artifactHash)throw new AppError(409,'addon_staged_file_changed','A queued JAR is missing or changed. Cancel that change and upload or download it again.');
          const metadata=await inspectJar(artifact);const compatible=addonCompatibility(change.type,server,metadata);
          if(!compatible.compatible)throw new AppError(422,'addon_incompatible',compatible.message??'A queued add-on is incompatible.');
          bytes+=(await lstat(artifact)).size;
        }
      }
      await this.ensureSpace(this.backupsDirectory,bytes);await this.ensureSpace(this.serversDirectory,bytes);
      journal={id:randomUUID(),serverId:server.id,state:'applying',createdAt:new Date().toISOString(),targets:[...targets.values()].map((target,index)=>({...target,backupIndex:index})),
        beforeRows:this.database.prepare('SELECT * FROM addon_installs WHERE server_id=?').all(server.id) as AddonChangeJournal['beforeRows']};
      const backup=await this.backupRoot(journal,true);
      for(const target of journal.targets)if(target.beforeHash){const current=await this.target(server,target.type,target.fileName);const destination=await safePath(backup,target.backupIndex+'.jar',true);await copyFile(current.file,destination,constants.COPYFILE_EXCL);await syncFile(destination);if(await hashFile(destination)!==target.beforeHash)throw new AppError(409,'addon_changed','An installed JAR changed while its backup was being created.');}
      this.pending.saveJournal(journal);
      for(const change of changes){
        this.assertStopped(this.current(server));
        await this.directory(server,change.type,true);
        if(change.action!=='remove')await this.replace(server,change.type,change.fileName,await this.storage('artifacts/'+change.id+'.jar'),journal.id,change.baseline[change.fileName],change.artifactHash);
        if(change.action==='remove'||change.originalFileName){
          const name=change.originalFileName??change.fileName;const target=await this.target(server,change.type,name);
          if(target.hash!==change.baseline[name])throw new AppError(409,'addon_changed','An installed JAR changed before its queued removal. NodePilot refused to overwrite the external change.');
          if(target.hash)await rm(target.file,{force:false});
        }
      }
      this.database.transaction(()=>{
        for(const change of changes){
          if(change.action==='remove'||change.originalFileName)this.database.prepare('DELETE FROM addon_installs WHERE server_id=? AND addon_type=? AND file_name=?').run(server.id,change.type,change.originalFileName??change.fileName);
          if(change.action!=='remove'){
            const now=new Date().toISOString();this.database.prepare(`INSERT INTO addon_installs(server_id,addon_type,file_name,source,project_id,version_id,installed_at,updated_at)VALUES(?,?,?,?,?,?,?,?)
              ON CONFLICT(server_id,addon_type,file_name)DO UPDATE SET source=excluded.source,project_id=excluded.project_id,version_id=excluded.version_id,updated_at=excluded.updated_at`).run(server.id,change.type,change.fileName,change.source,change.projectId??null,change.versionId??null,now,now);
          }
          this.pending.remove(server.id,change.id);
        }
        this.pending.removeJournal(server.id);
      })();
      for(const change of changes)if(change.artifactHash)await this.storage('artifacts/'+change.id+'.jar').then(file=>rm(file,{force:true})).catch(()=>undefined);
      return backup;
    }catch(error){
      let message=errorMessage(error);
      if(journal&&this.pending.journal(server.id)){
        try{await this.rollback(server,journal);}catch(rollbackError){journal.state='recovery_required';journal.error='Add-on recovery could not finish: '+errorMessage(rollbackError)+'. Restart NodePilot to retry recovery. Full JAR backups were retained.';this.pending.saveJournal(journal);message+=' '+journal.error;}
      }
      for(const change of changes){change.error=message;this.pending.save(change);}
      throw new AppError(409,'addon_pending_failed','Minecraft was not started because queued add-ons could not be applied: '+message);
    }
  }
  private async replace(server:ServerRecord,type:AddonType,name:string,source:string,journalId:string,expectedBefore?:string|null,expectedAfter?:string):Promise<void>{
    const directory=await this.directory(server,type,true);const target=await this.target(server,type,name);
    const temporary=await safePath(directory,'.nodepilot-addon-'+journalId+'-'+safeAddonFileName(name)+'.tmp',true);
    try{
      await copyFile(source,temporary,constants.COPYFILE_EXCL);await syncFile(temporary);
      if(expectedAfter&&await hashFile(temporary)!==expectedAfter)throw new AppError(409,'addon_staged_file_changed','A queued JAR changed while it was being applied.');
      await this.directory(server,type);
      if(expectedBefore!==undefined){const current=await this.target(server,type,name);if(current.fileName!==target.fileName||current.hash!==expectedBefore)throw new AppError(409,'addon_changed','An installed JAR changed before replacement. NodePilot refused to overwrite the external change.');}
      await rename(temporary,target.file);
    }
    finally{await rm(temporary,{force:true}).catch(()=>undefined);}
  }
  private async rollback(server:ServerRecord,journal:AddonChangeJournal):Promise<void>{
    this.assertStopped(server);const backup=await this.backupRoot(journal);
    // Verify every snapshot first: a partial/corrupt backup never overwrites good files.
    for(const target of journal.targets){
      safeAddonFileName(target.fileName);
      if(target.beforeHash&&await hashFile(await safePath(backup,target.backupIndex+'.jar'))!==target.beforeHash)throw new Error('A recovery JAR backup is missing or corrupt.');
      const current=await this.target(server,target.type,target.fileName);
      if(current.hash!==target.beforeHash&&current.hash!==target.afterHash)throw new Error('An add-on file was changed outside NodePilot during recovery. Preserve it and restore the retained backup manually.');
    }
    for(const target of journal.targets){
      const directory=await this.directory(server,target.type);
      const temporary=path.join(directory,'.nodepilot-addon-'+journal.id+'-'+target.fileName+'.tmp');
      if(await present(temporary)){const info=await lstat(temporary);if(!info.isFile()||info.isSymbolicLink())throw new Error('An unsafe temporary add-on file prevents recovery.');await rm(temporary,{force:true});}
      if(target.beforeHash)await this.replace(server,target.type,target.fileName,await safePath(backup,target.backupIndex+'.jar'),journal.id);
      else{const current=await this.target(server,target.type,target.fileName);if(current.hash)await rm(current.file,{force:false});}
    }
    this.database.transaction(()=>{
      this.database.prepare('DELETE FROM addon_installs WHERE server_id=?').run(server.id);
      for(const row of journal.beforeRows)this.database.prepare('INSERT INTO addon_installs(server_id,addon_type,file_name,source,project_id,version_id,installed_at,updated_at)VALUES(?,?,?,?,?,?,?,?)').run(server.id,row.addon_type,row.file_name,row.source,row.project_id,row.version_id,row.installed_at,row.updated_at);
      this.pending.removeJournal(server.id);
    })();
  }
  async recover():Promise<void>{
    for(const journal of this.pending.journals()){
      const server=this.options.getServer?this.options.getServer(journal.serverId):this.servers.find(journal.serverId);
      if(!server)continue;
      try{await this.rollback(server,journal);for(const change of this.pending.list(server.id)){change.error='NodePilot restarted during an add-on change. Original JARs were restored; start again to retry or cancel the queued changes.';this.pending.save(change);}}
      catch(error){journal.state='recovery_required';journal.error='Interrupted add-on change needs recovery: '+errorMessage(error)+'. Restart NodePilot to retry; retained JAR backups must be restored before starting.';this.pending.saveJournal(journal);}
    }
  }
}
