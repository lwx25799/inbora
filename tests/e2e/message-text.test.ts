import {afterAll,beforeAll,expect,test} from 'vitest';
import {createServer,type ViteDevServer} from 'vite';
import {chromium,type Browser,type Page} from 'playwright';
import {createElement,type ComponentType} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {mkdir} from 'node:fs/promises';
import {resolve} from 'node:path';

let server:ViteDevServer,browser:Browser,page:Page,MessageText:ComponentType<{text:string}>;
beforeAll(async()=>{
  server=await createServer({configFile:resolve('desktop/vite.config.ts'),server:{middlewareMode:true},appType:'custom',logLevel:'error'});
  MessageText=(await server.ssrLoadModule('/src/MessageText.tsx')).MessageText;
  browser=await chromium.launch({channel:'msedge',headless:true,args:['--mute-audio']});page=await browser.newPage();
});
afterAll(async()=>{await browser?.close();await server?.close();});
async function display(text:string){
  const html=renderToStaticMarkup(createElement(MessageText,{text}));
  await page.setContent('<main style="font:20px Segoe UI;white-space:pre-wrap;padding:20px">'+html+'</main>');
}

test.each([{width:900,height:640},{width:1240,height:800}])('known emoji labels keep text and repetition order at $width×$height',async viewport=>{
  await page.setViewportSize(viewport);const original='收到[赞] [微笑][赞]\n谢谢🙂';await display(original);
  expect(await page.locator('main').textContent()).toBe('收到👍 🙂👍\n谢谢🙂');
  const emoji=page.getByRole('img');expect(await emoji.count()).toBe(3);
  expect(await emoji.evaluateAll(nodes=>nodes.map(node=>[node.getAttribute('aria-label'),node.getAttribute('title')]))).toEqual([
    ['[赞]','[赞]'],['[微笑]','[微笑]'],['[赞]','[赞]'],
  ]);
  expect(original).toBe('收到[赞] [微笑][赞]\n谢谢🙂');
  expect(await emoji.evaluateAll(nodes=>nodes.every(node=>{const r=node.getBoundingClientRect();return r.width>0&&r.height>0;}))).toBe(true);
  const output=resolve('.local/message-text-evidence');await mkdir(output,{recursive:true});
  await page.locator('main').screenshot({path:resolve(output,`labels-${viewport.width}.png`)});
});

test('untrusted HTML and Markdown remain text while exact known labels stay accessible',async()=>{
  const text='<img src=x onerror="window.injected=1">[赞]<script>window.injected=1</script> **[微笑]**';await display(text);
  expect(await page.locator('main').textContent()).toBe('<img src=x onerror="window.injected=1">👍<script>window.injected=1</script> **🙂**');
  expect(await page.locator('main img, main script, main strong, main a').count()).toBe(0);
  expect(await page.getByRole('img').count()).toBe(2);
  expect(await page.evaluate(()=>Object.hasOwn(window,'injected'))).toBe(false);
});

test('unknown, malformed, plain Unicode and empty content keep their original characters',async()=>{
  for(const text of ['[未知][微笑笑][赞同][constructor][__proto__][微\n笑] 普通🙂👍',' \n原文\t', '']){
    await display(text);expect(await page.locator('main').textContent()).toBe(text);expect(await page.getByRole('img').count()).toBe(0);
  }
});
