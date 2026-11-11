import {afterAll,beforeAll,expect,test} from 'vitest';
import {createServer,type ViteDevServer} from 'vite';
import {createElement,type ComponentType} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {resolve} from 'node:path';

let server:ViteDevServer,MessageText:ComponentType<{text:string}>;
beforeAll(async()=>{
  server=await createServer({configFile:resolve('desktop/vite.config.ts'),server:{middlewareMode:true},appType:'custom',logLevel:'error'});
  MessageText=(await server.ssrLoadModule('/src/MessageText.tsx')).MessageText;
});
afterAll(async()=>{await server?.close();});
const render=(text:string)=>renderToStaticMarkup(createElement(MessageText,{text}));

test('common platform labels render accessible Unicode equivalents in their original order',()=>{
  const source='[玫瑰][鼓掌][比心][笑哭][双手合十][玫瑰]';
  const html=render(source);
  expect(html.match(/role="img"/gu)).toHaveLength(6);
  expect(html.replace(/<[^>]*>/gu,'')).toBe('🌹👏❤️😂🙏🌹');
  for(const label of ['[玫瑰]','[鼓掌]','[比心]','[笑哭]','[双手合十]']){
    expect(html).toContain('aria-label="'+label+'"');expect(html).toContain('title="'+label+'"');
  }
  expect(source).toBe('[玫瑰][鼓掌][比心][笑哭][双手合十][玫瑰]');
});

test('unknown tags, prototype names, exact whitespace and complex Unicode stay text',()=>{
  const text=' [未知][constructor][__proto__][狗头]\n👩🏽‍🚒🇨🇳❤️\t';
  expect(render(text).replace(/<[^>]*>/gu,'')).toBe(text);
  expect(render(text)).not.toContain('role="img"');
  expect(render('[赞]')).toContain('role="img"');
});

test('recognized emoji never turn neighbouring markup or newlines into HTML',()=>{
  const html=render('<script>alert(1)</script>[玫瑰][笑\n哭]');
  expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
  expect(html).not.toContain('<script>');expect(html).not.toContain('<img');
  expect(html.match(/role="img"/gu)).toHaveLength(1);
  expect(html).toContain('[笑\n哭]');
});
