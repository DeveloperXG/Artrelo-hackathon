'use strict';
const { StringDecoder } = require('string_decoder');
const { fail } = require('./operatorInput.service');
function hiddenInput(prompt, { input = process.stdin, output = process.stdout, maxBytes = 256 } = {}) {
  if (!input.isTTY || !output.isTTY || typeof input.setRawMode !== 'function') return Promise.reject(fail('HIDDEN_TTY_REQUIRED'));
  return new Promise((resolve, reject) => {
    const decoder = new StringDecoder('utf8'), wasRaw = !!input.isRaw;
    let value = '', settled = false;
    const finish = error => {
      if (settled) return;settled = true;
      input.off('data', onData);input.off('end', onEnd);input.off('error', onError);
      input.setRawMode(wasRaw);input.pause();output.write('\n');
      const result = value;value = '';
      if (error) reject(error);else resolve(result);
    };
    const onEnd = () => finish(fail('SECRET_INPUT_CANCELLED'));
    const onError = () => finish(fail('SECRET_INPUT_CANCELLED'));
    const onData = chunk => {
      const text = decoder.write(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      for (let n = 0; n < text.length; n++) {
        const char = text[n];
        if (char === '\x03' || char === '\x04') return finish(fail('SECRET_INPUT_CANCELLED'));
        if (char === '\r' || char === '\n') {
          if (text.slice(n).replace(/^\r?\n?/, '').length) return finish(fail('MULTILINE_SECRET_INPUT_REFUSED'));
          return finish();
        }
        if (char === '\x7f' || char === '\b') value = Array.from(value).slice(0, -1).join('');
        else if (char === '\x15') value = '';
        else if (char.charCodeAt(0) >= 32) value += char;
        if (Buffer.byteLength(value) > maxBytes) return finish(fail('SECRET_INPUT_TOO_LONG'));
      }
    };
    output.write(prompt);input.setRawMode(true);
    input.on('data', onData);input.once('end', onEnd);input.once('error', onError);input.resume();
  });
}
async function confirmedInput(label, options) {
  const first = await hiddenInput(label + ': ', options);
  const second = await hiddenInput('Confirm ' + label + ': ', options);
  if (first !== second) throw fail('SECRET_CONFIRMATION_MISMATCH');
  return first;
}
module.exports = { hiddenInput, confirmedInput };
