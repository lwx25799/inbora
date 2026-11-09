# Diagnostics and evidence maintenance source notice

The cumulative model/status aggregation in `src/app/diagnostics.ts` adapts the
grouped statistics query from `Yht20927/douyin-cli`,
`lib/memory/llm-usage.js:56-74`, at commit
`4073159bea585de6d33a4747a475669440737932`.

Source: https://github.com/Yht20927/douyin-cli/blob/4073159bea585de6d33a4747a475669440737932/lib/memory/llm-usage.js

Its `lib/commands/cleanup.js` provided the bounded dry-run/execute organization
for the shared CLI/desktop evidence maintenance. Inbora independently adds
persistent-reference protection, filename/content checks, cancellation and the
100-file limit. It does not copy upstream database deletion, hardcoded model
prices, error text or private payload collection.

The source license is retained below.

MIT License

Copyright (c) 2026 Yht20927

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
