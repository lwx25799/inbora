import { spawn } from "node:child_process";
import { readFile, writeFile, rename, rm } from "node:fs/promises";
import { closeSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync,
  renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import type { ModelKeyStorage } from "../contracts/model-providers.js";
import { Blocked, digest, requireSafe } from "../core/contracts.js";

function dpapi(input:Buffer,operation:'Protect'|'Unprotect',scopeDigest?:string):Promise<Buffer> {
  requireSafe(process.platform==='win32','DPAPI_WINDOWS_REQUIRED');
  const entropy=scopeDigest===undefined?'inbora:model-key:v1':`inbora:model-credential:v1:${scopeDigest}`;
  // The secret travels on stdin, never argv, environment, a script file or a log.
  const script=`$ErrorActionPreference='Stop';Add-Type -AssemblyName System.Security;$bytes=[Convert]::FromBase64String([Console]::In.ReadToEnd());
  try{$entropy=[Text.Encoding]::UTF8.GetBytes('${entropy}');$result=[Security.Cryptography.ProtectedData]::${operation}($bytes,$entropy,[Security.Cryptography.DataProtectionScope]::CurrentUser);
  [Console]::Out.Write([Convert]::ToBase64String($result));[Array]::Clear($result,0,$result.Length)}finally{[Array]::Clear($bytes,0,$bytes.Length)}`;
  return new Promise((resolve,reject)=>{
    const child=spawn('powershell.exe',['-NoLogo','-NoProfile','-NonInteractive','-Command',script],{windowsHide:true,stdio:['pipe','pipe','pipe']});
    let output='';const timer=setTimeout(()=>{child.kill();reject(Error('DPAPI_OPERATION_FAILED'));},10_000);
    child.stdout.on('data',(chunk:Buffer)=>{output+=chunk.toString('ascii');if(output.length>32_000)child.kill();});
    child.stderr.resume();child.on('error',()=>{clearTimeout(timer);reject(Error('DPAPI_OPERATION_FAILED'));});
    child.on('close',code=>{clearTimeout(timer);if(code!==0||!output||!/^[A-Za-z0-9+/=]+$/.test(output))reject(Error('DPAPI_OPERATION_FAILED'));else resolve(Buffer.from(output,'base64'));});
    child.stdin.on('error',()=>{});child.stdin.end(input.toString('base64'));
  });
}
export class CredentialStore {
  private static queues=new Map<string,Promise<unknown>>();
  private file:string;
  constructor(root:string){this.file=join(root,'model-key.dpapi');}
  private sequence<T>(operation:()=>Promise<T>):Promise<T>{
    const task=(CredentialStore.queues.get(this.file)??Promise.resolve()).catch(()=>{}).then(operation);
    CredentialStore.queues.set(this.file,task);
    void task.finally(()=>{if(CredentialStore.queues.get(this.file)===task)CredentialStore.queues.delete(this.file);}).catch(()=>{});
    return task;
  }
  load():Promise<string|null> {return this.sequence(()=>this.read());}
  private async read():Promise<string|null> {
    let encrypted:Buffer;
    try{encrypted=await readFile(this.file);}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return null;throw error;}
    requireSafe(encrypted.byteLength<=16_000,'DPAPI_FILE_INVALID');
    const key=await dpapi(encrypted,'Unprotect');
    try{const text=key.toString('utf8');requireSafe(text.length>0&&text.length<=4000&&!/[\r\n]/u.test(text),'INVALID_MODEL_KEY');return text;}finally{key.fill(0);}
  }
  save(key:string):Promise<void> {return this.sequence(()=>this.write(key));}
  private async write(key:string):Promise<void> {
    requireSafe(key.length>0&&key.length<=4000&&!/[\r\n]/u.test(key),'INVALID_MODEL_KEY');
    const plain=Buffer.from(key,'utf8');let encrypted:Buffer;
    try{encrypted=await dpapi(plain,'Protect');}finally{plain.fill(0);}
    const temporary=`${this.file}.${randomUUID()}.tmp`;
    try{await writeFile(temporary,encrypted,{flag:'wx',mode:0o600});await rename(temporary,this.file);}
    finally{await rm(temporary,{force:true});encrypted.fill(0);}
  }
  delete():Promise<void>{return this.sequence(async()=>{await rm(this.file,{force:true});});}
}

export type ModelCredentialRef = {
  connectionId: string;
  credentialRevision: string;
  storage: ModelKeyStorage;
};

export interface ModelCredentialProtector {
  protect(input: Buffer, ref: Readonly<ModelCredentialRef>): Promise<Buffer>;
  unprotect(input: Buffer, ref: Readonly<ModelCredentialRef>): Promise<Buffer>;
}

export interface ModelCredentialRegistry {
  listCleanableCredentials(): ModelCredentialRef[];
  claimCredentialCleanup(ref: ModelCredentialRef): boolean;
  finishCredentialCleanup(ref: ModelCredentialRef, removed: boolean): void;
}

const credentialScope = (ref: ModelCredentialRef) => digest([ref.connectionId, ref.credentialRevision]);
const windowsProtector: ModelCredentialProtector = {
  protect: (input, ref) => dpapi(input, "Protect", credentialScope(ref)),
  unprotect: (input, ref) => dpapi(input, "Unprotect", credentialScope(ref)),
};

const canonicalUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
export function validateModelCredentialRef(ref: ModelCredentialRef): void {
  requireSafe(typeof ref.connectionId === "string" && canonicalUuid.test(ref.connectionId)
    && typeof ref.credentialRevision === "string" && canonicalUuid.test(ref.credentialRevision)
    && (ref.storage === "MEMORY" || ref.storage === "DPAPI"), "INVALID_MODEL_CREDENTIAL_ID");
}

function validateModelKey(key: string): void {
  requireSafe(typeof key === "string" && key.trim().length > 0 && key.length <= 4000
    && !/[\r\n]/u.test(key) && key.isWellFormed(), "INVALID_MODEL_KEY");
}

function statIfPresent(path: string) {
  try { return lstatSync(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export class ModelCredentialStore {
  private static readonly queues = new Map<string, Promise<unknown>>();
  private readonly root: string;
  private readonly queueKey: string;
  private readonly memory = new Map<string, string>();

  constructor(root: string, private readonly protector: ModelCredentialProtector = windowsProtector) {
    const path = resolve(root);
    const stats = lstatSync(path);
    requireSafe(stats.isDirectory() && !stats.isSymbolicLink(), "INVALID_MODEL_CREDENTIAL_PATH");
    this.root = realpathSync.native(path);
    this.queueKey = process.platform === "win32" ? this.root.toLowerCase() : this.root;
  }

  private async sequence<T>(operation: () => Promise<T>): Promise<T> {
    const task = (ModelCredentialStore.queues.get(this.queueKey) ?? Promise.resolve()).catch(() => {}).then(operation);
    ModelCredentialStore.queues.set(this.queueKey, task);
    try { return await task; }
    finally {
      if (ModelCredentialStore.queues.get(this.queueKey) === task) ModelCredentialStore.queues.delete(this.queueKey);
    }
  }

  private credentialPath(ref: ModelCredentialRef, create: boolean): string | null {
    validateModelCredentialRef(ref);
    const base = join(this.root, "model-credentials");
    const directory = join(base, ref.connectionId);
    for (const path of [this.root, base, directory]) {
      let stats = statIfPresent(path);
      if (!stats && create && path !== this.root) {
        mkdirSync(path, { mode: 0o700 });
        stats = lstatSync(path);
      }
      if (!stats) {
        requireSafe(path !== this.root, "INVALID_MODEL_CREDENTIAL_PATH");
        return null;
      }
      requireSafe(stats.isDirectory() && !stats.isSymbolicLink(), "INVALID_MODEL_CREDENTIAL_PATH");
    }
    return join(directory, ref.credentialRevision + ".dpapi");
  }

  private readCiphertext(ref: ModelCredentialRef): Buffer {
    const file = this.credentialPath(ref, false);
    const stats = file ? statIfPresent(file) : null;
    requireSafe(file && stats?.isFile() && !stats.isSymbolicLink() && stats.nlink === 1
      && stats.size > 0 && stats.size <= 16_000, "DPAPI_RESTORE_FAILED");
    return readFileSync(file);
  }

  private async openKey(ref: ModelCredentialRef): Promise<string> {
    const encrypted = this.readCiphertext(ref);
    let plain: Buffer | undefined;
    try {
      plain = await this.protector.unprotect(encrypted, ref);
      const key = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(plain);
      validateModelKey(key);
      return key;
    } finally {
      plain?.fill(0);
      encrypted.fill(0);
    }
  }

  load(ref: ModelCredentialRef, isActive: (ref: ModelCredentialRef) => boolean): Promise<string | null> {
    const target = Object.freeze({ ...ref });
    return this.sequence(async () => {
      validateModelCredentialRef(target);
      if (!isActive(target)) return null;
      if (target.storage === "MEMORY") return this.memory.get(credentialScope(target)) ?? null;
      let key: string;
      try { key = await this.openKey(target); }
      catch {
        if (!isActive(target)) return null;
        throw new Blocked("DPAPI_RESTORE_FAILED");
      }
      return isActive(target) ? key : null;
    });
  }

  private async writeCiphertext(ref: ModelCredentialRef, key: string): Promise<void> {
    const plain = Buffer.from(key, "utf8");
    let encrypted: Buffer | undefined;
    try {
      try { encrypted = await this.protector.protect(plain, ref); }
      catch { throw new Blocked("DPAPI_OPERATION_FAILED"); }
      requireSafe(encrypted.byteLength > 0 && encrypted.byteLength <= 16_000, "DPAPI_FILE_INVALID");
      const file = this.credentialPath(ref, true)!;
      requireSafe(!statIfPresent(file), "MODEL_CREDENTIAL_ALREADY_EXISTS");
      const temporary = file + ".tmp";
      const handle = openSync(temporary, "wx", 0o600);
      try {
        try {
          writeFileSync(handle, encrypted);
          fsyncSync(handle);
        } finally { closeSync(handle); }
        requireSafe(this.credentialPath(ref, false) === file && !statIfPresent(file), "INVALID_MODEL_CREDENTIAL_PATH");
        renameSync(temporary, file);
      } catch (error) {
        if (this.credentialPath(ref, false) === file) this.removePrivateFile(temporary);
        throw error;
      }
    } finally {
      plain.fill(0);
      encrypted?.fill(0);
    }
  }

  private remove(ref: ModelCredentialRef): void {
    if (ref.storage === "MEMORY") {
      this.memory.delete(credentialScope(ref));
      return;
    }
    const file = this.credentialPath(ref, false);
    if (file) this.removePrivateFile(file);
  }

  private removePrivateFile(file: string): void {
    const stats = statIfPresent(file);
    if (!stats) return;
    requireSafe(stats.isFile() && !stats.isSymbolicLink() && stats.nlink === 1, "MODEL_CREDENTIAL_CLEANUP_FAILED");
    unlinkSync(file);
  }

  // Called under OwnerLock on startup. Only a marker written by save qualifies for reconciliation.
  cleanupStaged(isRegistered: (ref: ModelCredentialRef) => boolean): Promise<boolean> {
    return this.sequence(async () => {
      const base = join(this.root, "model-credentials");
      const baseStats = statIfPresent(base);
      if (!baseStats) return true;
      let succeeded = true;
      requireSafe(baseStats.isDirectory() && !baseStats.isSymbolicLink(), "INVALID_MODEL_CREDENTIAL_PATH");
      for (const connectionId of readdirSync(base)) {
        if (!canonicalUuid.test(connectionId)) continue;
        const directory = join(base, connectionId);
        let names: string[];
        try {
          const stats = statIfPresent(directory);
          if (!stats?.isDirectory() || stats.isSymbolicLink()) continue;
          names = readdirSync(directory).sort();
        } catch {
          succeeded = false;
          continue;
        }
        for (const name of names) {
          if (!name.endsWith(".dpapi.pending")) continue;
          const credentialRevision = name.slice(0, -".dpapi.pending".length);
          if (!canonicalUuid.test(credentialRevision)) continue;
          const ref = { connectionId, credentialRevision, storage: "DPAPI" } as const;
          try {
            const file = this.credentialPath(ref, false);
            if (!file) continue;
            const marker = file + ".pending";
            const pending = statIfPresent(marker);
            if (!pending?.isFile() || pending.isSymbolicLink() || pending.nlink !== 1 || pending.size !== 0) continue;
            if (!isRegistered(ref)) this.remove(ref);
            this.removePrivateFile(file + ".tmp");
            this.removePrivateFile(marker);
          } catch {
            // Keep the failed marker for reconciliation on the next startup.
            succeeded = false;
          }
        }
      }
      return succeeded;
    });
  }

  // The publisher must synchronously commit registration and the route edit before returning.
  save<T>(connectionId: string, key: string,
    publish: (ref: ModelCredentialRef) => T & (T extends PromiseLike<unknown> ? never : unknown),
    storage: ModelKeyStorage = "MEMORY", check?: () => undefined): Promise<T> {
    return this.sequence(async () => {
      const ref = Object.freeze({ connectionId, credentialRevision: randomUUID(), storage });
      validateModelCredentialRef(ref);
      validateModelKey(key);
      requireSafe(Object.prototype.toString.call(publish) !== "[object AsyncFunction]"
        && Object.prototype.toString.call(check) !== "[object AsyncFunction]", "MODEL_PROVIDER_TRANSACTION_HOOK_ASYNC");
      requireSafe(check?.() === undefined, "MODEL_PROVIDER_TRANSACTION_HOOK_ASYNC");
      const file = storage === "DPAPI" ? this.credentialPath(ref, true)! : null;
      const marker = file ? file + ".pending" : null;
      if (marker) {
        requireSafe(!statIfPresent(file!), "MODEL_CREDENTIAL_ALREADY_EXISTS");
        const handle = openSync(marker, "wx", 0o600);
        try { fsyncSync(handle); } finally { closeSync(handle); }
      } else this.memory.set(credentialScope(ref), key);
      let result: T;
      try {
        if (marker) {
          await this.writeCiphertext(ref, key);
          try { requireSafe(await this.openKey(ref) === key, "DPAPI_RESTORE_FAILED"); }
          catch { throw new Blocked("DPAPI_RESTORE_FAILED"); }
        }
        result = publish(ref);
        requireSafe(typeof (result as { then?: unknown } | undefined | null)?.then !== "function",
          "MODEL_PROVIDER_TRANSACTION_HOOK_ASYNC");
      } catch (error) {
        try {
          this.remove(ref);
          if (marker) {
            this.removePrivateFile(file! + ".tmp");
            this.removePrivateFile(marker);
          }
        }
        catch { throw new Blocked("MODEL_CREDENTIAL_CLEANUP_FAILED"); }
        throw error;
      }
      // The authoritative row is committed. A marker left behind is resolved on the next startup.
      if (marker) {
        try { this.removePrivateFile(marker); } catch { /* Keep the published credential. */ }
      }
      return result;
    });
  }

  cleanup(registry: ModelCredentialRegistry): Promise<void> {
    return this.sequence(async () => {
      for (const ref of registry.listCleanableCredentials()) {
        if (!registry.claimCredentialCleanup(ref)) continue;
        let removed = false;
        try {
          validateModelCredentialRef(ref);
          this.remove(ref);
          removed = true;
        } catch {
          // The revoked row records the fixed cleanup error and can be retried later.
        } finally {
          registry.finishCredentialCleanup(ref, removed);
        }
      }
    });
  }
}
