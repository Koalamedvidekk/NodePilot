import { randomUUID, createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { copyFile, lstat, mkdir, readFile, readdir, realpath, rename, rm, stat, statfs, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';

import { AppError, errorMessage } from '../lib/errors.js';
import { isInside, resolveManagedServerRoot } from '../lib/paths.js';
import { parseJavaProperties, patchJavaProperties } from '../lib/java-properties.js';
import { discoverWorldGroups, resolveWorldGroup, safeWorldPath } from '../lib/world-layout.js';
import { metadataFiles, metadataRevision, patchWorldMetadata, readWorldMetadata } from '../lib/world-metadata.js';
import { WorldRepository, type WorldRecord, type WorldBackupRecord, type WorldOperationRecord } from '../repositories/world-repository.js';
import type { ServerRepository } from '../repositories/server-repository.js';
import type { ServerRecord } from '../types.js';
import type { WorldBackup, WorldCapabilities, WorldDetails, WorldGenerationOptions, WorldGroup, WorldList, WorldMetadata, WorldOperation, WorldSummary } from '../world-types.js';
import { compareMinecraftVersions, isStableMinecraftVersion } from './server-version-service.js';
import { WorldArchiveService } from './world-archive-service.js';
import { WorldDatapackService } from './world-datapack-service.js';

const nameSchema = z.string().trim().min(1).max(64).regex(/^[^\x00-\x1f\x7f]+$/);
const generationSchema = z.object({
  seed: z.string().max(256).regex(/^[^\r\n\0]*$/), preset: z.string().min(1).max(128),
  generatorSettings: z.string().max(16_384), structures: z.boolean(), hardcore: z.boolean(),
  difficulty: z.enum(['peaceful','easy','normal','hard']),
  enabledPacks: z.array(z.string().min(1).max(256)).max(128), disabledPacks: z.array(z.string().min(1).max(256)).max(128),
});
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const javaSoftware = new Set(['vanilla','paper','spigot','purpur','fabric','forge','neoforge','quilt']);
const activeStates = new Set(['starting','running','stopping','installing']);
const publicOperation = ({recovery: _recovery, artifact: _artifact, ...operation}: WorldOperationRecord): WorldOperation => operation;
type Journal = { serverId: string; worldId: string | null; files: Array<{relative:string; exists:boolean}>; directory: string;
  before: WorldRecord | null; created: string[]; fullBackup: string | null; group: WorldGroup | null };
type Context = {server:ServerRecord;root:string;properties:Record<string,string>;text:string;worlds:WorldRecord[];active:WorldRecord|null;checked?:{revision:string;worldId?:string}};
type Job = { operation:WorldOperationRecord; phase:(value:string)=>void; progress:(processed:number,total:number)=>void };

function generationFromProperties(values:Record<string,string>, metadata?:WorldMetadata):WorldGenerationOptions {
  const difficulty = values.difficulty;
  return {
    seed:values['level-seed'] ?? metadata?.seed ?? '', preset:values['level-type'] || metadata?.preset || 'minecraft:normal',
    generatorSettings:values['generator-settings'] || '{}', structures:metadata?.structures ?? values['generate-structures'] !== 'false',
    hardcore:metadata?.hardcore ?? values.hardcore === 'true',
    difficulty:metadata?.difficulty ?? (['peaceful','easy','normal','hard'].includes(difficulty) ? difficulty as WorldGenerationOptions['difficulty'] : 'normal'),
    enabledPacks:metadata?.enabledPacks.length ? metadata.enabledPacks : (values['initial-enabled-packs'] || 'vanilla').split(',').filter(Boolean),
    disabledPacks:metadata?.disabledPacks ?? (values['initial-disabled-packs'] || '').split(',').filter(Boolean),
  };
}
function generationProperties(options:WorldGenerationOptions):Record<string,string> {
  return {'level-seed':options.seed,'level-type':options.preset,'generator-settings':options.generatorSettings,
    'generate-structures':String(options.structures),hardcore:String(options.hardcore),difficulty:options.hardcore?'hard':options.difficulty,
    'initial-enabled-packs':options.enabledPacks.join(','),'initial-disabled-packs':options.disabledPacks.join(',')};
}
function presets(version:string):WorldCapabilities['presets'] {
  const old = /^1\.(\d+)/.exec(version);
  const modern = !old || Number(old[1]) >= 18;
  return [{id:modern?'minecraft:normal':'default',name:'Normal'}, {id:modern?'minecraft:flat':'flat',name:'Superflat'},
    {id:modern?'minecraft:large_biomes':'largeBiomes',name:'Large biomes'}, {id:modern?'minecraft:amplified':'amplified',name:'Amplified'},
    ...(modern ? [{id:'minecraft:single_biome_surface',name:'Single biome'}] : [])];
}
async function exists(file:string):Promise<boolean> { return lstat(file).then(()=>true,(error:NodeJS.ErrnoException)=>{if(error.code==='ENOENT')return false;throw error;}); }
async function atomicWrite(file:string,content:string|Buffer):Promise<void> {
  const temporary = file+'.nodepilot-'+randomUUID()+'.tmp';
  try {await writeFile(temporary,content,{flag:'wx',mode:0o600});await rename(temporary,file);}
  finally {await rm(temporary,{force:true}).catch(()=>undefined);}
}
function overlaps(left:string,right:string):boolean {
  const canonical=(value:string)=>value.replaceAll('\\','/').normalize('NFC').toLowerCase();
  const a=canonical(left),b=canonical(right);
  return a===b||a.startsWith(b+'/')||b.startsWith(a+'/');
}

/** Saved-world operations deliberately never launch or send commands to Minecraft. */
export class WorldService {
  private readonly phases=new Map<string,WorldOperationRecord>();
  private readonly tasks=new Set<Promise<void>>();
  private stopping=false;
  private readonly archives:WorldArchiveService;
  private readonly packs:WorldDatapackService;
  private readonly sizeCache=new Map<string,{at:number;value:number|null}>();
  constructor(
    private readonly config:{serversDirectory:string;dataDirectory:string;backupsDirectory:string},
    private readonly servers:ServerRepository,
    private readonly catalogue:WorldRepository,
    private readonly runtime:{isProcessActive(id:string):boolean},
    private readonly shouldPause:()=>boolean=()=>false,
  ) {this.archives=new WorldArchiveService(config);this.packs=new WorldDatapackService(config.serversDirectory);}

  isBusy(id:string):boolean{return this.phases.has(id);}
  anyBusy():boolean{return this.phases.size>0;}
  hasRecoveryBlock(id:string):boolean{return this.catalogue.unresolved(id).length>0;}
  assertCanStart(id:string):void {
    if(this.isBusy(id))throw new AppError(409,'world_operation_in_progress','A world operation is in progress. Wait until it finishes before starting the server.');
    if(this.hasRecoveryBlock(id))throw new AppError(409,'world_recovery_required','An interrupted world operation needs recovery. Restore a world backup before starting this server.');
  }
  async validateStart(id:string):Promise<void> {
    this.assertCanStart(id);
    const server=this.requireServer(id);
    if(!this.supported(server))return;
    // Reading only: starting a server must never select another world or repair files.
    const root=await resolveManagedServerRoot(this.config.serversDirectory,server.directory);
    const properties=parseJavaProperties(await readFile(await safeWorldPath(root,'server.properties'),'utf8'));
    const group=await resolveWorldGroup(root,properties['level-name']||'world',server.software,server.version);
    const metadata=await readWorldMetadata(root,group);
    if(metadata.minecraftVersion&&isStableMinecraftVersion(metadata.minecraftVersion)&&isStableMinecraftVersion(server.version)
      &&compareMinecraftVersions(metadata.minecraftVersion,server.version)>0) {
      throw new AppError(409,'world_downgrade_refused','The selected world was saved in Minecraft '+metadata.minecraftVersion+'. Use a compatible server version before starting.');
    }
    this.assertCanStart(id);
  }
  async stop():Promise<void>{this.stopping=true;await Promise.allSettled([...this.tasks]);}
  private requireServer(id:string):ServerRecord {
    const server=this.servers.find(id);if(!server)throw new AppError(404,'server_not_found','The server does not exist.');return server;
  }
  private supported(server:ServerRecord):boolean{return server.game==='minecraft-java' && javaSoftware.has(server.software);}
  private assertStopped(id:string):ServerRecord {
    const server=this.requireServer(id);
    if(!this.supported(server))throw new AppError(422,'worlds_unsupported','World management currently supports known Java server software. Bedrock uses a different world format.');
    if(this.stopping||this.shouldPause())throw new AppError(409,'panel_update_in_progress','Wait for NodePilot maintenance to finish before changing worlds.');
    if(this.runtime.isProcessActive(id)||activeStates.has(server.status))throw new AppError(409,'server_active','Stop the server before changing, backing up, or downloading worlds.');
    if(server.installState!=='ready')throw new AppError(409,'server_not_ready','Finish or repair this server installation before managing worlds.');
    return server;
  }
  private capabilities(server:ServerRecord):WorldCapabilities {
    const reason=!this.supported(server)?'World management is available for supported Java servers only.'
      :this.stopping||this.shouldPause()?'NodePilot is performing application maintenance.'
      :this.runtime.isProcessActive(server.id)||activeStates.has(server.status)?'Stop the server before changing, backing up, or downloading worlds.'
      :this.isBusy(server.id)?'Wait for the current world operation to finish.' : null;
    const unavailable=reason??(server.installState!=='ready'?'Finish or repair this server installation before managing worlds.':null);
    return {canMutate:!unavailable,reason:unavailable,presets:presets(server.version)};
  }
  private async context(id:string):Promise<Context> {
    const server=this.requireServer(id);
    const root=await resolveManagedServerRoot(this.config.serversDirectory,server.directory);
    const propertyFile=await safeWorldPath(root,'server.properties');
    const text=await readFile(propertyFile,'utf8');
    if(Buffer.byteLength(text)>1_000_000)throw new AppError(413,'properties_too_large','The server properties file is too large.');
    const properties=parseJavaProperties(text);
    const activeFolder=(properties['level-name']||'world').replaceAll('\\','/');
    let groups:WorldGroup[];
    try {
      await safeWorldPath(root,activeFolder,true);
      groups=await discoverWorldGroups(root,server.software,server.version,activeFolder);
    } catch(error) {
      const group=await resolveWorldGroup(root,activeFolder,server.software,server.version);
      group.readOnlyReason??=errorMessage(error);
      groups=[group];
    }
    const old=this.catalogue.list(id);
    for(const group of groups){
      const current=old.find(world=>world.folder===group.folder);
      if(current){
        if(!current.deleted){
          const metadata=await readWorldMetadata(root,group);
          // Capture the last saved per-world settings instead of reusing the previous
          // primary world's values after a switch. Never replace requested random seed.
          const generation={...current.generation};
          if(metadata.generated&&!metadata.readOnlyReason){
            if(metadata.difficulty!==null)generation.difficulty=metadata.difficulty;
            if(metadata.hardcore!==null)generation.hardcore=metadata.hardcore;
            if(metadata.preset!==null)generation.preset=metadata.preset;
            if(metadata.structures!==null)generation.structures=metadata.structures;
            if(metadata.enabledPacks.length)generation.enabledPacks=metadata.enabledPacks;
            generation.disabledPacks=metadata.disabledPacks;
          }
          if(JSON.stringify(current.group)!==JSON.stringify(group)||JSON.stringify(current.generation)!==JSON.stringify(generation))this.catalogue.save({...current,group,generation});
        }
        continue;
      }
      const metadata=await readWorldMetadata(root,group);
      const now=new Date().toISOString();
      this.catalogue.save({id:randomUUID(),serverId:id,name:path.posix.basename(group.folder),folder:group.folder,group,
        generation:generationFromProperties(group.folder===activeFolder?properties:{},metadata),
        state:metadata.generated?'generated':metadata.readOnlyReason?'unavailable':'prepared',deleted:false,createdAt:now,updatedAt:now});
    }
    let worlds=this.catalogue.list(id);
    if(!worlds.some(world=>world.folder===activeFolder)){
      const group=await resolveWorldGroup(root,activeFolder,server.software,server.version);
      const now=new Date().toISOString();
      this.catalogue.save({id:randomUUID(),serverId:id,name:path.posix.basename(activeFolder),folder:activeFolder,group,
        generation:generationFromProperties(properties),state:'prepared',deleted:false,createdAt:now,updatedAt:now});
      worlds=this.catalogue.list(id);
    }
    // An imported/nested world or a Windows case alias must never turn a
    // recursive operation on one catalogue entry into a change to another.
    for(let first=0;first<worlds.length;first++)for(let second=first+1;second<worlds.length;second++){
      const a=worlds[first],b=worlds[second];
      if(a.deleted||b.deleted||!a.group.members.some(left=>b.group.members.some(right=>overlaps(left,right))))continue;
      a.group={...a.group,readOnlyReason:'World directories overlap with '+b.name+'. Resolve the overlapping or aliased directories before changing either world.'};
      b.group={...b.group,readOnlyReason:'World directories overlap with '+a.name+'. Resolve the overlapping or aliased directories before changing either world.'};
    }
    return {server,root,properties,text,worlds,active:worlds.find(world=>world.folder===activeFolder)??null};
  }
  private assertExclusive(context:Context,worldId:string,members:string[]):void {
    const conflict=context.worlds.find(other=>other.id!==worldId&&!other.deleted&&members.some(left=>other.group.members.some(right=>overlaps(left,right))));
    if(conflict)throw new AppError(409,'overlapping_worlds','These directories overlap with '+conflict.name+'. Preserve and separate the world directories before continuing.');
  }
  private world(context:Context,id:string):WorldRecord {
    const world=context.worlds.find(candidate=>candidate.id===id);
    if(!world)throw new AppError(404,'world_not_found','The saved world does not exist.');return world;
  }
  private async revision(context:Context,world:WorldRecord):Promise<string> {
    return hash(JSON.stringify(world)+context.server.version+hash(context.text)+(world.deleted?'deleted':await metadataRevision(context.root,world.group)));
  }
  private async summary(context:Context,world:WorldRecord):Promise<WorldSummary> {
    let metadata:WorldMetadata|null=null;
    if(!world.deleted)metadata=await readWorldMetadata(context.root,world.group);
    let present=false;
    try{present=await exists(await safeWorldPath(context.root,world.folder,true));}catch{/* Resolver diagnostics keep an unsafe world visible and read-only. */}
    const generated=Boolean(metadata?.generated);
    let sizeBytes:number|null=null;
    if(present&&!world.deleted){
      const key=context.server.id+':'+world.id;
      const cached=this.sizeCache.get(key);
      if(cached&&Date.now()-cached.at<60_000)sizeBytes=cached.value;
      else {try{sizeBytes=(await this.archives.measureWorld(context.server,world.group)).sizeBytes;}catch{/* Unknown is never displayed as zero. */}
        this.sizeCache.set(key,{at:Date.now(),value:sizeBytes});}
    }
    return {id:world.id,deleted:world.deleted,name:world.name,folder:world.folder,active:context.active?.id===world.id,
      state:world.deleted?'missing':metadata?.readOnlyReason||world.group.readOnlyReason?'unavailable':!present?(world.state==='prepared'?'prepared':'missing'):generated?'generated':'prepared',
      layout:world.group.layout,seed:metadata?.seed??null,minecraftVersion:metadata?.minecraftVersion??null,dataVersion:metadata?.dataVersion??null,
      difficulty:metadata?.difficulty??null,hardcore:metadata?.hardcore??null,dimensions:world.group.dimensions,
      sizeBytes,lastSavedAt:metadata?.lastSavedAt??null,revision:await this.revision(context,world),
      readOnlyReason:world.deleted?'This world was deleted. Restore a saved backup to use it again.':metadata?.readOnlyReason??world.group.readOnlyReason};
  }
  async list(id:string):Promise<WorldList>{
    const server=this.requireServer(id);
    if(!this.supported(server))return {supported:false,unsupportedReason:'World management currently supports Java Edition. Bedrock worlds and packs require a separate adapter.',
      activeWorldId:null,worlds:[],capabilities:this.capabilities(server),operation:null,warnings:[],revision:hash(id+server.version)};
    const context=await this.context(id);
    const worlds=await Promise.all(context.worlds.map(world=>this.summary(context,world)));
    const customPath=context.server.startupConfig.gameArguments.some(arg=>['--universe','--world-container','--world','--level-name','-W','-w'].includes(arg));
    const capabilities=this.capabilities(server);
    if(customPath){capabilities.canMutate=false;capabilities.reason='Custom world paths in startup arguments need manual review. World changes are unavailable for this launch configuration.';}
    return {supported:true,unsupportedReason:null,activeWorldId:context.active?.id??null,worlds,capabilities,
      operation:this.phases.has(id)?publicOperation(this.phases.get(id)!):null,
      warnings:['Player inventories, XP, advancements, statistics, and locations stay with their world. Plugin or mod data stored outside world folders remains server-wide.',
        ...(this.hasRecoveryBlock(id)?['An interrupted operation needs recovery. Restore the affected world from a backup before starting the server.']:[])],
      revision:hash(hash(context.text)+worlds.map(world=>world.revision).join(':'))};
  }
  async details(id:string,worldId:string):Promise<WorldDetails>{
    const context=await this.context(id);const world=this.world(context,worldId);
    const summary=await this.summary(context,world);
    const metadata=world.deleted?null:await readWorldMetadata(context.root,world.group);
    let datapacks:WorldDetails['datapacks']=[];const warnings=[...(metadata?.warnings??[])];
    if(metadata&&!world.deleted)try{datapacks=await this.packs.list(context.server,world.group,metadata.generated?metadata:{...metadata,enabledPacks:world.generation.enabledPacks,disabledPacks:world.generation.disabledPacks});}catch(error){warnings.push(errorMessage(error));}
    const state=await this.list(id);
    return {world:summary,generation:world.generation,gameRules:metadata?.gameRules??[],features:metadata?.features??[],datapacks,
      backups:this.catalogue.backups(worldId,id).map(({directory:_directory,group:_group,generation:_generation,serverId:_serverId,...backup})=>backup),
      capabilities:state.capabilities,warnings,metadataSource:summary.state==='prepared'?'not-generated':this.runtime.isProcessActive(id)||activeStates.has(context.server.status)?'last-saved':'saved'};
  }

  private async preflight(id:string,revision:string,worldId?:string,allowDeleted=false):Promise<{context:Context;world:WorldRecord|null}> {
    this.assertStopped(id);
    if(this.isBusy(id))throw new AppError(409,'world_operation_in_progress','Wait for the current world operation to finish.');
    if(this.hasRecoveryBlock(id)&&!allowDeleted)throw new AppError(409,'world_recovery_required','Restore the affected world from a backup before making other world changes. Restarting NodePilot also retries interrupted recovery.');
    const context=await this.context(id);
    const listing=await this.list(id);
    if(!listing.capabilities.canMutate)throw new AppError(409,'world_changes_unavailable',listing.capabilities.reason??'World changes are unavailable.');
    const world=worldId?this.world(context,worldId):null;
    if(world?.deleted&&!allowDeleted)throw new AppError(409,'world_deleted','Restore this world from a backup before using it.');
    const expected=world?await this.revision(context,world):listing.revision;
    if(typeof revision!=='string'||revision!==expected)throw new AppError(409,'stale_world','World files or settings changed. Refresh the Worlds tab and review your changes before retrying.');
    context.checked={revision,worldId};
    return {context,world};
  }
  private async editable(context:Context,world:WorldRecord):Promise<WorldMetadata> {
    if(world.group.readOnlyReason)throw new AppError(409,'world_read_only',world.group.readOnlyReason);
    const metadata=await readWorldMetadata(context.root,world.group);
    if(metadata.readOnlyReason)throw new AppError(409,'world_read_only',metadata.readOnlyReason);
    return metadata;
  }
  private enqueue(checked:string|Context,worldId:string|null,kind:string,work:(job:Job)=>Promise<WorldOperation['result']>):WorldOperation {
    const id=typeof checked==='string'?checked:checked.server.id;
    this.assertStopped(id);
    if(this.isBusy(id))throw new AppError(409,'world_operation_in_progress','Wait for the current world operation to finish.');
    const now=new Date().toISOString();
    const operation:WorldOperationRecord={id:randomUUID(),serverId:id,worldId,kind,state:'running',phase:'checking',processedBytes:0,totalBytes:null,error:null,result:null,createdAt:now,updatedAt:now,recovery:null,artifact:null};
    this.catalogue.saveOperation(operation);this.phases.set(id,operation);
    const save=()=>this.catalogue.saveOperation(operation);
    let lastProgress=0;
    const task=(async()=>{
      try{
        // The lock is already held. Recheck state after asynchronous validation so
        // a file request finishing during preflight cannot be silently overwritten.
        this.assertStopped(id);
        if(typeof checked!=='string'&&checked.checked){
          const fresh=await this.context(id);
          const expected=checked.checked.worldId?await this.revision(fresh,this.world(fresh,checked.checked.worldId)):(await this.list(id)).revision;
          if(expected!==checked.checked.revision)throw new AppError(409,'stale_world','World files or settings changed. Refresh the Worlds tab before retrying.');
        }
        operation.result=await work({operation,phase(value){operation.phase=value;save();},progress(processed,total){operation.processedBytes=processed;operation.totalBytes=total;
          if(Date.now()-lastProgress>250||processed===total){lastProgress=Date.now();save();}}});
        operation.state='succeeded';operation.phase='complete';operation.recovery=null;save();
      }catch(error){
        let message=errorMessage(error);
        if(operation.recovery)try{await this.rollback(operation);operation.recovery=null;}catch(recoveryError){operation.phase='recovery_required';message+=' Automatic recovery could not finish: '+errorMessage(recoveryError)+'. Restore the world backup before starting the server.';}
        operation.state='failed';if(operation.phase!=='recovery_required')operation.phase='failed';operation.error=message;save();
      }finally{this.phases.delete(id);this.sizeCache.clear();}
    })().finally(()=>this.tasks.delete(task));
    this.tasks.add(task);return publicOperation(operation);
  }
  operation(id:string,operationId:string):WorldOperation {
    this.requireServer(id);const operation=this.catalogue.operation(operationId,id);
    if(!operation)throw new AppError(404,'world_operation_not_found','The world operation does not exist.');return publicOperation(operation);
  }
  async artifact(id:string,operationId:string):Promise<string>{
    const operation=this.catalogue.operation(operationId,id);
    if(!operation||operation.state!=='succeeded'||!operation.artifact)throw new AppError(404,'world_download_unavailable','This world download is not ready.');
    const root=await realpath(path.join(this.config.dataDirectory,'worlds','exports'));
    const file=operation.artifact;
    if(!isInside(root,file)||(await lstat(file)).isSymbolicLink()||!(await lstat(file)).isFile()||!isInside(root,await realpath(file)))throw new AppError(409,'unsafe_world_download','NodePilot refused an unsafe download path.');
    return file;
  }

  private async journal(job:Job,context:Context,world:WorldRecord|null,options:{created?:string[];fullBackup?:string;extraFiles?:string[]}={}):Promise<void>{
    const directory=path.join(this.config.dataDirectory,'worlds','journals',job.operation.id);
    await mkdir(directory,{recursive:true,mode:0o700});
    const relatives=[...new Set(['server.properties',...(world?metadataFiles(world.group):[]),...(options.extraFiles??[])])];
    const files:Journal['files']=[];
    for(const relative of relatives){
      const source=await safeWorldPath(context.root,relative,true);const present=await exists(source);
      files.push({relative,exists:present});
      if(present){const info=await lstat(source);if(!info.isFile()||info.size>64*1024*1024)throw new AppError(413,'world_metadata_too_large','A world metadata file cannot be safely snapshotted.');
        const target=path.join(directory,'files',relative);await mkdir(path.dirname(target),{recursive:true});await copyFile(source,target,constants.COPYFILE_EXCL);}
    }
    const journal:Journal={serverId:context.server.id,worldId:world?.id??null,files,directory,before:world,created:options.created??[],fullBackup:options.fullBackup??null,group:world?.group??null};
    job.operation.recovery=JSON.stringify(journal);this.catalogue.saveOperation(job.operation);
  }
  private async rollback(operation:WorldOperationRecord):Promise<void>{
    if(!operation.recovery)return;
    const journal=JSON.parse(operation.recovery) as Journal;
    const server=this.requireServer(operation.serverId);
    const root=await resolveManagedServerRoot(this.config.serversDirectory,server.directory);
    const journalBase=await realpath(path.join(this.config.dataDirectory,'worlds','journals'));
    if(!isInside(journalBase,journal.directory)||!isInside(journalBase,await realpath(journal.directory)))throw new Error('Invalid world recovery journal.');
    if(journal.fullBackup&&journal.group)await this.archives.restoreWorld(server,journal.group,journal.fullBackup);
    for(const relative of journal.created){const target=await safeWorldPath(root,relative,true);if(await exists(target))await rm(target,{recursive:true,force:true});}
    for(const file of journal.files){
      const target=await safeWorldPath(root,file.relative,true);
      if(file.exists){const source=path.resolve(journal.directory,'files',file.relative);if(!isInside(journal.directory,source))throw new Error('Invalid recovery file.');await mkdir(path.dirname(target),{recursive:true});await atomicWrite(target,await readFile(source));}
      else if(await exists(target))await rm(target,{force:true});
    }
    if(journal.before)this.catalogue.save(journal.before);
    else if(operation.worldId)this.catalogue.remove(operation.worldId,operation.serverId);
  }
  async recover():Promise<void>{
    for(const operation of this.catalogue.unfinished()){
      try{await this.rollback(operation);operation.recovery=null;operation.phase='recovered';operation.error='NodePilot restarted during this operation. Previous world settings were restored; retry when ready.';}
      catch(error){operation.phase='recovery_required';operation.error='Interrupted world operation needs recovery: '+errorMessage(error);}
      operation.state='failed';this.catalogue.saveOperation(operation);
    }
  }
  private async writeProperties(context:Context,changes:Record<string,string>):Promise<void>{
    const file=await safeWorldPath(context.root,'server.properties');await atomicWrite(file,patchJavaProperties(await readFile(file,'utf8'),changes));
  }
  private async ensureSpace(directory:string,bytes:number):Promise<void>{
    await mkdir(directory,{recursive:true});
    try{const info=await statfs(directory);if(Number(info.bavail)*Number(info.bsize)<bytes+64*1024*1024)throw new AppError(507,'insufficient_disk_space','There is not enough free space for a safe world backup or transfer.');}
    catch(error){if(error instanceof AppError)throw error;}
  }
  private async backupInternal(context:Context,world:WorldRecord,job:Job):Promise<WorldBackupRecord>{
    if(!world.group.members.length)throw new AppError(409,'world_read_only',world.group.readOnlyReason??'This world group cannot be safely backed up.');
    const size=(await this.archives.measureWorld(context.server,world.group)).sizeBytes;
    await this.ensureSpace(this.config.backupsDirectory,size);
    const id=randomUUID();const directory=path.join(this.config.backupsDirectory,'world-'+id);
    job.phase('backing_up');
    const copied=await this.archives.copyWorld(context.server,world.group,directory,job.progress);
    const backup:WorldBackupRecord={id,worldId:world.id,serverId:context.server.id,name:world.name,createdAt:new Date().toISOString(),sizeBytes:copied.sizeBytes,directory,group:world.group,generation:world.generation};
    this.catalogue.saveBackup(backup);return backup;
  }
  private checkCompatibility(context:Context,metadata:WorldMetadata,confirm:boolean):boolean{
    if(!metadata.generated)return false;
    if(metadata.minecraftVersion&&isStableMinecraftVersion(metadata.minecraftVersion)&&isStableMinecraftVersion(context.server.version)){
      const comparison=compareMinecraftVersions(metadata.minecraftVersion,context.server.version);
      if(comparison>0)throw new AppError(409,'world_downgrade_refused','This world was saved in Minecraft '+metadata.minecraftVersion+'. Select a compatible server version before loading it.');
      return comparison<0;
    }
    if(!confirm)throw new AppError(409,'world_compatibility_confirmation','The saved world version could not be verified. Review compatibility and confirm before loading it.');
    return true;
  }

  async prepare(id:string,input:{name:string;revision:string}&WorldGenerationOptions):Promise<WorldOperation>{
    const {context}=await this.preflight(id,input.revision);
    const name=nameSchema.parse(input.name);const generation=generationSchema.parse(input);
    if(!presets(context.server.version).some(preset=>preset.id===generation.preset))throw new AppError(422,'unsupported_world_preset','Choose a supported world preset for this Minecraft version.');
    try{const settings:unknown=JSON.parse(generation.generatorSettings);if(!settings||typeof settings!=='object'||Array.isArray(settings))throw new Error();}
    catch{throw new AppError(400,'invalid_generator_settings','Generator settings must be a JSON object.');}
    if(generation.hardcore)generation.difficulty='hard';
    const source=context.active;
    if(source){const metadata=await readWorldMetadata(context.root,source.group);await this.packs.validateSelection(context.server,source.group,{...metadata,generated:false},generation.enabledPacks,generation.disabledPacks);}
    else if(generation.enabledPacks.some(pack=>pack!=='vanilla'))throw new AppError(422,'datapack_unavailable','Select datapacks available on the current world.');
    return this.enqueue(context,null,'prepare',async job=>{
      this.assertStopped(id);
      const slug=name.toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'').slice(0,32)||'new';
      const folder='world-'+slug+'-'+randomUUID().slice(0,8);
      const created=[folder,folder+'_nether',folder+'_the_end'];
      for(const relative of created)if(await exists(await safeWorldPath(context.root,relative,true)))throw new AppError(409,'world_exists','The world directory already exists.');
      const worldId=randomUUID();job.operation.worldId=worldId;this.catalogue.saveOperation(job.operation);
      await this.journal(job,context,null,{created});job.phase('preparing');
      await mkdir(await safeWorldPath(context.root,folder,true),{recursive:false});
      const group=await resolveWorldGroup(context.root,folder,context.server.software,context.server.version);
      if(source)await this.packs.copySelection(context.server,source.group,group,generation.enabledPacks);
      const now=new Date().toISOString();
      this.catalogue.save({id:worldId,serverId:id,name,folder,group,generation,state:'prepared',deleted:false,createdAt:now,updatedAt:now});
      await this.writeProperties(context,{'level-name':folder,...generationProperties(generation)});
      return {worldId};
    });
  }
  async activate(id:string,worldId:string,input:{revision:string;confirmCompatibility?:boolean}):Promise<WorldOperation>{
    const {context,world}=await this.preflight(id,input.revision,worldId);
    const metadata=await this.editable(context,world!);
    const needsBackup=this.checkCompatibility(context,metadata,input.confirmCompatibility===true);
    return this.enqueue(context,worldId,'activate',async job=>{
      if(needsBackup)await this.backupInternal(context,world!,job);
      await this.journal(job,context,world!);job.phase('selecting');
      await this.writeProperties(context,{'level-name':world!.folder,...generationProperties(world!.generation)});
      return {worldId};
    });
  }
  async update(id:string,worldId:string,input:{revision:string;name?:string;difficulty?:WorldGenerationOptions['difficulty'];hardcore?:boolean}):Promise<WorldOperation>{
    const {context,world}=await this.preflight(id,input.revision,worldId);
    const metadata=await this.editable(context,world!);
    const name=input.name===undefined?world!.name:nameSchema.parse(input.name);
    const generation={...world!.generation};
    if(input.difficulty!==undefined)generation.difficulty=z.enum(['peaceful','easy','normal','hard']).parse(input.difficulty);
    if(input.hardcore!==undefined)generation.hardcore=z.boolean().parse(input.hardcore);
    if(generation.hardcore)generation.difficulty='hard';
    return this.enqueue(context,worldId,'settings',async job=>{
      await this.journal(job,context,world!);job.phase('saving');
      if(metadata.generated&&(input.difficulty!==undefined||input.hardcore!==undefined))await patchWorldMetadata(context.root,world!.group,{difficulty:generation.difficulty,hardcore:generation.hardcore});
      this.catalogue.save({...world!,name,generation});
      if(context.active?.id===worldId)await this.writeProperties(context,generationProperties(generation));
      return {worldId};
    });
  }
  async saveRules(id:string,worldId:string,input:{revision:string;rules:Record<string,boolean|number>}):Promise<WorldOperation>{
    const {context,world}=await this.preflight(id,input.revision,worldId);const metadata=await this.editable(context,world!);
    if(!metadata.generated)throw new AppError(409,'world_not_generated','Game rules are available after Minecraft has generated this world.');
    const entries=Object.entries(input.rules??{});
    if(entries.length>256)throw new AppError(400,'too_many_game_rules','Too many game-rule values.');
    for(const [key,value] of entries){const rule=metadata.gameRules.find(candidate=>candidate.id===key);
      if(!rule?.editable)throw new AppError(422,'unsupported_game_rule','This saved game rule cannot be safely edited: '+key);
      if(rule.type==='boolean'&&typeof value!=='boolean'||rule.type==='integer'&&(typeof value!=='number'||!Number.isSafeInteger(value)||value<(rule.minimum??0)||value>(rule.maximum??2_147_483_647)))throw new AppError(400,'invalid_game_rule','Invalid value for '+key+'.');
    }
    return this.enqueue(context,worldId,'game_rules',async job=>{await this.journal(job,context,world!);job.phase('saving');await patchWorldMetadata(context.root,world!.group,{rules:input.rules});return {worldId};});
  }
  async backup(id:string,worldId:string,revision:string):Promise<WorldOperation>{
    const {context,world}=await this.preflight(id,revision,worldId);
    return this.enqueue(context,worldId,'backup',async job=>({worldId,backupId:(await this.backupInternal(context,world!,job)).id}));
  }
  async restore(id:string,worldId:string,backupId:string,input:{revision:string;confirm:true}):Promise<WorldOperation>{
    const {context,world}=await this.preflight(id,input.revision,worldId,true);
    if(input.confirm!==true)throw new AppError(400,'confirmation_required','Confirm the backup restoration.');
    const backup=this.catalogue.findBackup(backupId,id);
    if(!backup||backup.worldId!==worldId)throw new AppError(404,'world_backup_not_found','The world backup does not exist.');
    this.assertExclusive(context,worldId,[...world!.group.members,...backup.group.members]);
    return this.enqueue(context,worldId,'restore',async job=>{
      const created:string[]=[];
      for(const relative of backup.group.members){
        const present=await exists(await safeWorldPath(context.root,relative,true));
        if(present&&!world!.deleted&&!world!.group.members.includes(relative))throw new AppError(409,'world_restore_collision','A backup dimension directory now belongs to a different layout. Preserve and move that directory before restoring; nothing was overwritten.');
        if(present&&world!.deleted)throw new AppError(409,'world_restore_collision','The deleted world directory has been recreated outside NodePilot. Preserve it before restoring this backup.');
        if(!present)created.push(relative);
      }
      const current=world!.deleted?null:await this.backupInternal(context,world!,job);
      await this.journal(job,context,world!,{fullBackup:current?.directory,created});
      job.phase('restoring');await this.archives.restoreWorld(context.server,backup.group,backup.directory,job.progress);
      // A version migration can consolidate Paper's old sibling dimensions into
      // one modern directory. Remove obsolete members only after a full snapshot
      // and a durable rollback journal have been recorded.
      if(!world!.deleted)for(const relative of world!.group.members.filter(member=>!backup.group.members.includes(member))){
        const target=await safeWorldPath(context.root,relative,true);if(await exists(target))await rm(target,{recursive:true,force:true});
      }
      const group=await resolveWorldGroup(context.root,world!.folder,context.server.software,context.server.version);
      const metadata=await readWorldMetadata(context.root,group);
      if(metadata.readOnlyReason)throw new AppError(409,'world_restore_layout',metadata.readOnlyReason);
      this.checkCompatibility(context,metadata,true);
      this.catalogue.save({...world!,group,generation:backup.generation,deleted:false,state:metadata.generated?'generated':'prepared'});
      if(context.active?.id===worldId)await this.writeProperties(context,{'level-name':world!.folder,...generationProperties(backup.generation)});
      this.catalogue.resolveRecovery(id,worldId);return {worldId,backupId};
    });
  }
  async delete(id:string,worldId:string,input:{revision:string;confirmName:string}):Promise<WorldOperation>{
    const {context,world}=await this.preflight(id,input.revision,worldId);
    if(context.active?.id===worldId)throw new AppError(409,'active_world','Select another world before deleting this one.');
    this.assertExclusive(context,worldId,world!.group.members);
    if(input.confirmName!==world!.name)throw new AppError(400,'world_confirmation_required','Type the world name exactly to confirm deletion.');
    await this.editable(context,world!);
    return this.enqueue(context,worldId,'delete',async job=>{
      const backup=await this.backupInternal(context,world!,job);await this.journal(job,context,world!,{fullBackup:backup.directory});job.phase('deleting');
      for(const relative of world!.group.members){const target=await safeWorldPath(context.root,relative,true);if(await exists(target))await rm(target,{recursive:true,force:true});}
      this.catalogue.save({...world!,deleted:true,state:'missing'});return {worldId,backupId:backup.id};
    });
  }
  async export(id:string,worldId:string,revision:string):Promise<WorldOperation>{
    const {context,world}=await this.preflight(id,revision,worldId);
    if(!world!.group.members.length)throw new AppError(409,'world_read_only',world!.group.readOnlyReason??'This world group cannot be safely exported.');
    return this.enqueue(context,worldId,'export',async job=>{
      const directory=path.join(this.config.dataDirectory,'worlds','exports');const size=(await this.archives.measureWorld(context.server,world!.group)).sizeBytes;
      await this.ensureSpace(directory,size);job.phase('exporting');
      const destination=path.join(directory,job.operation.id+'.zip');
      await this.archives.exportWorld(context.server,world!.group,destination,job.progress);
      job.operation.artifact=destination;this.catalogue.saveOperation(job.operation);
      return {worldId,downloadUrl:'/api/servers/'+id+'/worlds/operations/'+job.operation.id+'/download'};
    });
  }
  async inspectImport(id:string,archive:string):Promise<WorldOperation>{
    this.assertStopped(id);return this.enqueue(id,null,'inspect_import',async job=>{job.phase('inspecting');return {inspection:await this.archives.inspect(this.requireServer(id),archive,job.progress)};});
  }
  async import(id:string,input:{revision:string;inspectionId:string;candidateId:string;name:string;confirmCompatibility?:boolean}):Promise<WorldOperation>{
    const {context}=await this.preflight(id,input.revision);const name=nameSchema.parse(input.name);
    return this.enqueue(context,null,'import',async job=>{
      const folder='world-import-'+randomUUID().slice(0,12);const created=[folder,folder+'_nether',folder+'_the_end'];
      for(const relative of created)if(await exists(await safeWorldPath(context.root,relative,true)))throw new AppError(409,'world_exists','An import destination already exists.');
      const worldId=randomUUID();job.operation.worldId=worldId;this.catalogue.saveOperation(job.operation);
      await this.journal(job,context,null,{created});job.phase('importing');
      const group=await this.archives.importWorld(context.server,input.inspectionId,input.candidateId,folder,job.progress);
      const metadata=await readWorldMetadata(context.root,group);
      if(metadata.readOnlyReason||!metadata.generated)throw new AppError(422,'invalid_world',metadata.readOnlyReason??'No generated Minecraft world was found.');
      this.checkCompatibility(context,metadata,input.confirmCompatibility===true);
      const now=new Date().toISOString();
      this.catalogue.save({id:worldId,serverId:id,name,folder,group,generation:generationFromProperties({},metadata),state:'generated',deleted:false,createdAt:now,updatedAt:now});
      // Imported worlds remain inactive until the user explicitly selects them.
      return {worldId};
    });
  }
  private packRelative(world:WorldRecord,id:string):string {
    if(!id.startsWith('file/'))throw new AppError(409,'managed_datapack','Software-managed datapacks cannot be removed.');
    const name=id.slice(5);
    if(!name||name==='.'||name==='..'||/[\\/\x00-\x1f<>:"|?*]/.test(name))throw new AppError(400,'invalid_datapack','Invalid datapack identifier.');
    return world.folder+'/datapacks/'+name;
  }
  private async packFiles(root:string,relative:string):Promise<string[]> {
    const result:string[]=[];let bytes=0;
    const walk=async(value:string):Promise<void>=>{const absolute=await safeWorldPath(root,value,true);if(!await exists(absolute))return;const info=await lstat(absolute);
      if(info.isFile()){bytes+=info.size;result.push(value);if(result.length>100_000||bytes>1024*1024*1024)throw new AppError(413,'datapack_too_large','Datapack snapshots are limited to 1 GB and 100,000 files.');}
      else if(info.isDirectory())for(const child of await readdir(absolute))await walk(value+'/'+child);
      else throw new AppError(409,'unsafe_datapack','Linked or special datapack files are not supported.');};
    await walk(relative);return result;
  }
  async uploadPack(id:string,worldId:string,archive:string,filename:string,revision:string):Promise<WorldOperation>{
    const {context,world}=await this.preflight(id,revision,worldId);await this.editable(context,world!);
    const packId='file/'+filename;const relative=this.packRelative(world!,packId);
    if(!filename.toLowerCase().endsWith('.zip'))throw new AppError(400,'invalid_datapack','Upload a datapack ZIP archive.');
    if(await exists(await safeWorldPath(context.root,relative,true)))throw new AppError(409,'datapack_exists','A datapack with this name already exists.');
    return this.enqueue(context,worldId,'upload_datapack',async job=>{
      await this.journal(job,context,world!,{created:[relative]});job.phase('installing_datapack');
      const uploadedId=await this.packs.upload(context.server,world!.group,archive,filename);
      const metadata=await readWorldMetadata(context.root,world!.group);
      const generation={...world!.generation,disabledPacks:[...new Set([...world!.generation.disabledPacks,uploadedId])],enabledPacks:world!.generation.enabledPacks.filter(pack=>pack!==uploadedId)};
      if(metadata.generated)await patchWorldMetadata(context.root,world!.group,{enabledPacks:generation.enabledPacks,disabledPacks:generation.disabledPacks});
      this.catalogue.save({...world!,generation});if(context.active?.id===worldId)await this.writeProperties(context,generationProperties(generation));return {worldId};
    });
  }
  async selectPacks(id:string,worldId:string,input:{revision:string;enabled:string[];disabled:string[]}):Promise<WorldOperation>{
    const {context,world}=await this.preflight(id,input.revision,worldId);const metadata=await this.editable(context,world!);
    const enabled=z.array(z.string().max(256)).max(128).parse(input.enabled);const disabled=z.array(z.string().max(256)).max(128).parse(input.disabled);
    await this.packs.validateSelection(context.server,world!.group,{...metadata,enabledPacks:world!.generation.enabledPacks,disabledPacks:world!.generation.disabledPacks},enabled,disabled);
    return this.enqueue(context,worldId,'datapacks',async job=>{
      await this.journal(job,context,world!);job.phase('saving_datapacks');
      if(metadata.generated)await patchWorldMetadata(context.root,world!.group,{enabledPacks:enabled,disabledPacks:disabled});
      const generation={...world!.generation,enabledPacks:enabled,disabledPacks:disabled};this.catalogue.save({...world!,generation});
      if(context.active?.id===worldId)await this.writeProperties(context,generationProperties(generation));return {worldId};
    });
  }
  async removePack(id:string,worldId:string,packId:string,revision:string):Promise<WorldOperation>{
    const {context,world}=await this.preflight(id,revision,worldId);const metadata=await this.editable(context,world!);
    const relative=this.packRelative(world!,packId);const extraFiles=await this.packFiles(context.root,relative);
    return this.enqueue(context,worldId,'remove_datapack',async job=>{
      await this.journal(job,context,world!,{extraFiles});job.phase('removing_datapack');await this.packs.remove(context.server,world!.group,packId);
      const generation={...world!.generation,enabledPacks:world!.generation.enabledPacks.filter(pack=>pack!==packId),disabledPacks:world!.generation.disabledPacks.filter(pack=>pack!==packId)};
      if(metadata.generated)await patchWorldMetadata(context.root,world!.group,{enabledPacks:generation.enabledPacks,disabledPacks:generation.disabledPacks});
      this.catalogue.save({...world!,generation});if(context.active?.id===worldId)await this.writeProperties(context,generationProperties(generation));return {worldId};
    });
  }
}
