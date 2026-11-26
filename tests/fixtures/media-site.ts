import { createServer } from 'node:http';

export function silentWav(seconds = 2): Buffer {
  const samples = 8000 * seconds;
  const wav = Buffer.alloc(44 + samples * 2);
  wav.write('RIFF', 0); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(8000, 24); wav.writeUInt32LE(16000, 28); wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(samples * 2, 40);
  return wav;
}

// Entirely local synthetic media, no account, network platform, model or sends.
export async function mediaFixtureServer() {
  const wav = silentWav();
  let mediaRequests = 0;
  const server = createServer((request, response) => {
    if (request.url?.startsWith('/silence.wav')) {
      mediaRequests++;
      response.writeHead(200, { 'Content-Type': 'audio/wav', 'Content-Length': wav.length });
      response.end(wav); return;
    }
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    response.end(`<!doctype html><html><head><meta charset="utf-8"></head><body>
<audio id="initial" muted autoplay loop src="/silence.wav"></audio>
<audio id="empty"></audio><audio id="unloaded" preload="none" src="/silence.wav?unloaded"></audio>
<section id="comments"><span data-event="synthetic">original comment</span></section>
<textarea id="human-draft">unsaved human draft</textarea><img id="preview" alt="synthetic emoji preview" src="data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=">
<script>window.playFailures=0;window.addEventListener('unhandledrejection',event=>{window.playFailures++;event.preventDefault();});</script>
</body></html>`);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('MEDIA_FIXTURE_LISTEN_FAILED');
  return {
    origin: `http://127.0.0.1:${address.port}`,
    mediaRequests: () => mediaRequests,
    close: () => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())),
  };
}
