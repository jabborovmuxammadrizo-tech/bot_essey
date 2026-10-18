// A tiny template engine so the report layout can live in a plain HTML file (templates/report.html).
//
//   {{name}}            value, HTML-escaped          (dots allowed: brand.name)
//   {{{name}}}          value, inserted as raw HTML
//   {{name|nl}}         escaped, line breaks become <br>
//   {{#each list}} ... {{/each}}       repeat for every item; inside: {{field}}, {{this}}, {{@number}} (1, 2, 3...)
//   {{#if name}} ... {{else}} ... {{/if}}     shown when the value is not empty / not zero / not false
// Names that are not found inside the current item are looked up in the outer data.
const esc = (s) =>
  String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function parse(src) {
  const re = /\{\{\{\s*([^}]+?)\s*\}\}\}|\{\{\s*([^}]+?)\s*\}\}/g;
  const root = { type: 'root', children: [] };
  const stack = [root];
  const top = () => stack[stack.length - 1];
  const add = (node) => {
    const t = top();
    (t.type === 'if' && t.inElse ? t.otherwise : t.children).push(node);
  };
  let last = 0;
  let m;
  while ((m = re.exec(src))) {
    if (m.index > last) add({ type: 'text', value: src.slice(last, m.index) });
    last = re.lastIndex;
    const raw = m[1] !== undefined;
    const tag = (raw ? m[1] : m[2]).trim();
    if (!raw && tag.startsWith('#each ')) {
      const node = { type: 'each', path: tag.slice(6).trim(), children: [] };
      add(node); stack.push(node);
    } else if (!raw && tag.startsWith('#if ')) {
      const node = { type: 'if', path: tag.slice(4).trim(), children: [], otherwise: [], inElse: false };
      add(node); stack.push(node);
    } else if (!raw && tag === 'else') {
      if (top().type !== 'if') throw new Error('{{else}} outside {{#if}}');
      top().inElse = true;
    } else if (!raw && (tag === '/each' || tag === '/if')) {
      const n = stack.pop();
      if (!n || n.type !== tag.slice(1)) throw new Error('Unexpected ' + tag);
    } else {
      const [path, filter] = tag.split('|').map((s) => s.trim());
      add({ type: 'var', path, raw, filter });
    }
  }
  if (last < src.length) add({ type: 'text', value: src.slice(last) });
  if (stack.length !== 1) throw new Error('Unclosed {{#' + top().type + '}} block');
  return root;
}

function lookup(path, scopes) {
  const parts = path.split('.');
  for (let i = scopes.length - 1; i >= 0; i--) {
    const s = scopes[i];
    if (path === 'this' && i === scopes.length - 1) return s.value;
    if (s.special && path in s.special) return s.special[path];
    if (s.data && typeof s.data === 'object' && parts[0] in s.data) {
      let v = s.data;
      for (const p of parts) { if (v == null) return undefined; v = v[p]; }
      return v;
    }
  }
  return undefined;
}

const truthy = (v) => (Array.isArray(v) ? v.length > 0 : typeof v === 'string' ? v.trim() !== '' : !!v);

function run(nodes, scopes) {
  let out = '';
  for (const n of nodes) {
    if (n.type === 'text') out += n.value;
    else if (n.type === 'var') {
      const v = lookup(n.path, scopes);
      if (n.raw) out += v == null ? '' : String(v);
      else if (n.filter === 'nl') out += esc(v).replace(/\n/g, '<br>');
      else out += esc(v);
    } else if (n.type === 'if') {
      out += run(truthy(lookup(n.path, scopes)) ? n.children : n.otherwise, scopes);
    } else if (n.type === 'each') {
      const list = lookup(n.path, scopes);
      if (Array.isArray(list)) {
        list.forEach((item, i) => {
          const scope = { data: item && typeof item === 'object' ? item : null, value: item, special: { '@index': i, '@number': i + 1 } };
          out += run(n.children, scopes.concat(scope));
        });
      }
    }
  }
  return out;
}

function compile(src) {
  const tree = parse(src);
  return (data) => run(tree.children, [{ data, value: data, special: null }]);
}

module.exports = { compile, esc };
