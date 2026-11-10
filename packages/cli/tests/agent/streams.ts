import { PassThrough } from 'node:stream';

export function streams(inputTTY = true, outputTTY = false) {
  const input = Object.assign(new PassThrough(), { isTTY: inputTTY });
  const output = Object.assign(new PassThrough(), { isTTY: outputTTY, columns: 100 });
  let text = '';
  output.on('data', chunk => { text += String(chunk); });
  const waitFor = async (fragment: string, count = 1): Promise<void> => {
    if (text.split(fragment).length - 1 >= count) return;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        output.off('data', check);
        reject(new Error(`Did not see ${JSON.stringify(fragment)} ${count} times in ${JSON.stringify(text)}`));
      }, 2000);
      const check = () => {
        if (text.split(fragment).length - 1 < count) return;
        clearTimeout(timer);
        output.off('data', check);
        resolve();
      };
      output.on('data', check);
      check();
    });
  };
  return { input, output, text: () => text, waitFor };
}
