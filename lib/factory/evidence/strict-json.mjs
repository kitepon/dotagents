import { parseTree } from 'jsonc-parser';

// This parser is only used for private/local input. Public projection decoding is unchanged.
export function parseStrictJson(bytes, limit = 16 * 1024) {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength > limit) throw new Error('json_limit');
  const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  const errors = [];
  const tree = parseTree(text, errors, { disallowComments: true, allowTrailingComma: false, allowEmptyContent: false });
  if (errors.length || !tree) throw new Error('json_invalid');
  const inspect = (node, depth = 0) => {
    if (depth > 64) throw new Error('json_depth');
    if (node.type === 'object') {
      const seen = new Set();
      for (const property of node.children ?? []) {
        const key = property.children[0].value;
        if (seen.has(key)) throw new Error('json_duplicate_key');
        seen.add(key);
      }
    }
    for (const child of node.children ?? []) inspect(child, depth + 1);
  };
  inspect(tree);
  // JSON.parse preserves __proto__ as an own data property; never merge input into options.
  return JSON.parse(text);
}
