'use strict';
/**
 * Minimal YAML reader for the `x-homebox:` block of a module compose file.
 *
 * This is deliberately NOT a general YAML implementation. The dashboard ships
 * with zero npm dependencies so it can be built on a box with no registry
 * access, and the only YAML it ever reads is the metadata block we author
 * ourselves in modules/<id>/docker-compose.yml. The supported subset is:
 *
 *   key: scalar          nested maps by indentation
 *   key:                 block sequences (- item) including maps under a dash
 *   "quoted"/'quoted'    plain scalars, true/false, null/~, integers, floats
 *   # comments           whole-line, or trailing after an unquoted scalar
 *
 * Anything outside that subset (anchors, flow collections, multi-line
 * scalars, multiple documents) throws rather than guessing, so a malformed
 * module surfaces as a loud error in `homebox validate` instead of a module
 * that silently loses half its metadata.
 */

class YamlError extends Error {
  constructor(message, line) {
    super(line ? `${message} (line ${line})` : message);
    this.name = 'YamlError';
    this.line = line;
  }
}

/** Strip a trailing `# comment` that is not inside quotes. */
function stripComment(text) {
  let quote = null;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (ch === '\\' && quote === '"') i++;
      else if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === '#' && (i === 0 || /\s/.test(text[i - 1]))) {
      return text.slice(0, i);
    }
  }
  return text;
}

function parseScalar(raw, lineNo) {
  const text = raw.trim();
  if (text === '') return '';
  if (text[0] === '"') {
    if (text.length < 2 || text[text.length - 1] !== '"') {
      throw new YamlError('unterminated double-quoted string', lineNo);
    }
    return text
      .slice(1, -1)
      .replace(/\\n/g, '\n')
      .replace(/\\t/g, '\t')
      .replace(/\\"/g, '"')
      .replace(/\\\\/g, '\\');
  }
  if (text[0] === "'") {
    if (text.length < 2 || text[text.length - 1] !== "'") {
      throw new YamlError('unterminated single-quoted string', lineNo);
    }
    // In YAML, '' inside a single-quoted scalar is a literal apostrophe.
    return text.slice(1, -1).replace(/''/g, "'");
  }
  if (text === 'true' || text === 'yes') return true;
  if (text === 'false' || text === 'no') return false;
  if (text === 'null' || text === '~') return null;
  if (/^-?\d+$/.test(text)) return parseInt(text, 10);
  if (/^-?\d*\.\d+$/.test(text)) return parseFloat(text);
  if (text[0] === '[' || text[0] === '{') {
    throw new YamlError('flow collections are not supported here', lineNo);
  }
  return text;
}

/** Split "key: value" respecting quotes. Returns null when there is no key. */
function splitKey(text, lineNo) {
  let quote = null;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (ch === '\\' && quote === '"') i++;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === ':' && (i + 1 === text.length || /[\s]/.test(text[i + 1]))) {
      const key = parseScalar(text.slice(0, i), lineNo);
      return { key: String(key), rest: text.slice(i + 1).trim() };
    }
  }
  return null;
}

/**
 * Tokenize into { indent, content, lineNo }, dropping blank and comment lines.
 * Tabs are rejected outright: YAML forbids them for indentation and silently
 * treating one as spaces is how a file parses "fine" but nests wrong.
 */
function tokenize(text) {
  const out = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*(#.*)?$/.test(line)) continue;
    const indent = line.length - line.trimStart().length;
    if (/^ *\t/.test(line)) {
      throw new YamlError('tab used for indentation', i + 1);
    }
    const content = stripComment(line.trim()).trim();
    if (content === '') continue;
    if (content === '---' || content === '...') {
      throw new YamlError('multiple documents are not supported', i + 1);
    }
    out.push({ indent, content, lineNo: i + 1 });
  }
  return out;
}

/**
 * Parse the block of tokens at `indent` starting at index `i`.
 * Returns [value, nextIndex].
 */
function parseBlock(tokens, i, indent) {
  if (i >= tokens.length) return [null, i];

  if (tokens[i].content.startsWith('- ') || tokens[i].content === '-') {
    const list = [];
    while (i < tokens.length && tokens[i].indent === indent) {
      const tok = tokens[i];
      if (!(tok.content === '-' || tok.content.startsWith('- '))) break;
      const inline = tok.content === '-' ? '' : tok.content.slice(2).trim();
      if (inline === '') {
        // "-" alone: the item is the indented block that follows.
        const childIndent = i + 1 < tokens.length ? tokens[i + 1].indent : indent;
        if (childIndent <= indent) throw new YamlError('empty list item', tok.lineNo);
        const [value, next] = parseBlock(tokens, i + 1, childIndent);
        list.push(value);
        i = next;
        continue;
      }
      const pair = splitKey(inline, tok.lineNo);
      if (pair) {
        // "- key: value" — a map whose first key sits on the dash line. Its
        // remaining keys are indented to where that first key starts.
        const map = {};
        const keyIndent = indent + 2;
        if (pair.rest === '') {
          const childIndent = i + 1 < tokens.length ? tokens[i + 1].indent : keyIndent;
          if (childIndent > keyIndent) {
            const [value, next] = parseBlock(tokens, i + 1, childIndent);
            map[pair.key] = value;
            i = next;
          } else {
            map[pair.key] = null;
            i++;
          }
        } else {
          map[pair.key] = parseScalar(pair.rest, tok.lineNo);
          i++;
        }
        if (i < tokens.length && tokens[i].indent === keyIndent) {
          const [rest, next] = parseBlock(tokens, i, keyIndent);
          if (rest && typeof rest === 'object' && !Array.isArray(rest)) {
            Object.assign(map, rest);
            i = next;
          }
        }
        list.push(map);
        continue;
      }
      list.push(parseScalar(inline, tok.lineNo));
      i++;
    }
    return [list, i];
  }

  const map = {};
  while (i < tokens.length && tokens[i].indent === indent) {
    const tok = tokens[i];
    if (tok.content.startsWith('- ')) break;
    const pair = splitKey(tok.content, tok.lineNo);
    if (!pair) throw new YamlError(`expected "key: value", got: ${tok.content}`, tok.lineNo);
    if (pair.rest !== '') {
      map[pair.key] = parseScalar(pair.rest, tok.lineNo);
      i++;
      continue;
    }
    // Bare "key:" — value is the block below, at a deeper indent. A sequence
    // may legally sit at the SAME indent as its key, so allow that too.
    const next = tokens[i + 1];
    if (!next || (next.indent < indent) ||
        (next.indent === indent && !next.content.startsWith('- ') && next.content !== '-')) {
      map[pair.key] = null;
      i++;
      continue;
    }
    const [value, after] = parseBlock(tokens, i + 1, next.indent);
    map[pair.key] = value;
    i = after;
  }
  return [map, i];
}

/** Parse a YAML string in the supported subset. */
function parse(text) {
  const tokens = tokenize(text);
  if (tokens.length === 0) return null;
  const [value] = parseBlock(tokens, 0, tokens[0].indent);
  return value;
}

/**
 * Pull one top-level block (e.g. `x-homebox:`) out of a larger document and
 * parse only that. Cheaper and far safer than parsing a whole compose file
 * whose service definitions may use YAML we do not support.
 */
function extractTopLevel(text, key) {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((l) => l.startsWith(`${key}:`));
  if (start === -1) return null;
  const block = [];
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*$/.test(line)) {
      block.push(line);
      continue;
    }
    // A non-blank line back at column 0 ends the block.
    if (!/^\s/.test(line)) break;
    block.push(line);
  }
  return parse(block.join('\n'));
}

module.exports = { parse, extractTopLevel, YamlError };
