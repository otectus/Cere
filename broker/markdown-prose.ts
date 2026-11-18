// Yield the lines outside CommonMark fenced code blocks, preserving boundaries between prose blocks.
export function* proseLines(text: string) {
  let fence = '';
  for (const line of text.replace(/\r\n?/g, '\n').split('\n')) {
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (fence) {
      if (marker && marker[1][0] === fence[0] && marker[1].length >= fence.length && /^[ \t]*$/.test(marker[2])) fence = '';
      continue;
    }
    if (marker && (marker[1][0] === '~' || !marker[2].includes('`'))) {
      fence = marker[1];
      yield '';
    } else yield line;
  }
}
