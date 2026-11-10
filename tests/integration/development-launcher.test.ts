import {spawnSync} from 'node:child_process';
import {copyFileSync,mkdirSync,writeFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {expect,test} from 'vitest';
import {privateTemp} from '../helpers.js';

function fixture(){
  const root=privateTemp('development-launcher-');mkdirSync(join(root,'.local'));
  copyFileSync(resolve('启动inbora.cmd'),join(root,'start.cmd'));
  writeFileSync(join(root,'.local/start-development.cmd'),'@echo off\r\nwhere pnpm >nul 2>&1\r\nif errorlevel 1 exit /b 44\r\ncall pnpm --version\r\nexit /b %errorlevel%\r\n');
  const user=join(root,'user'),bin=join(user,'.cache/codex-runtimes/codex-primary-runtime/dependencies/bin/fallback');
  mkdirSync(bin,{recursive:true});writeFileSync(join(bin,'pnpm.cmd'),'@echo off\r\necho 11.25.0\r\nexit /b 0\r\n');
  const path=join(process.env.SystemRoot!,'System32')+';'+process.env.SystemRoot;
  const env=Object.fromEntries(Object.entries(process.env).filter(([name])=>name.toLowerCase()!=='path'));
  return{root,path,env,run:(extra:NodeJS.ProcessEnv={})=>spawnSync(process.env.ComSpec!,['/d','/c',join(root,'start.cmd')],
    {cwd:root,env:{...env,Path:path,USERPROFILE:user,...extra},input:'\r\n',encoding:'utf8',windowsHide:true,timeout:10000})};
}

test('Explorer startup resolves the existing pnpm for its child without global PATH changes',()=>{
  const f=fixture(),originalPath=process.env.Path??process.env.PATH,result=f.run();
  expect(result.error).toBeUndefined();expect(result.status,result.stdout+result.stderr).toBe(0);
  expect(result.stdout).toContain('11.25.0');expect(process.env.Path??process.env.PATH).toBe(originalPath);
});

test('startup keeps a pnpm already available in the caller environment',()=>{
  const f=fixture(),bin=join(f.root,'bin');mkdirSync(bin);writeFileSync(join(bin,'pnpm.cmd'),'@echo off\r\necho EXISTING_PNPM\r\nexit /b 0\r\n');
  const result=f.run({Path:bin+';'+f.path});expect(result.status,result.stdout+result.stderr).toBe(0);expect(result.stdout).toContain('EXISTING_PNPM');
});

test('missing pnpm leaves an explicit startup failure instead of silently closing',()=>{
  const f=fixture(),result=f.run({USERPROFILE:join(f.root,'missing-tools')});
  expect(result.error).toBeUndefined();expect(result.status).toBe(9009);expect(result.stdout).toContain('inbora could not find pnpm');
});
