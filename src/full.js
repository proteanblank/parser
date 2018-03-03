// =============================================================================
// Full Interactive Parser for Mathigon Textbooks
// (c) Mathigon
// =============================================================================


// TODO Parse tables without headers
// TODO Parse attributes for <ul> and <table>
// TODO Use Mathigon's custom expression parsing instead of AsciiMath


const yaml = require('yamljs');
const marked = require('marked');
const ascii2mathml = require('ascii2mathml');
const pug = require('pug');
const JSDom = require('jsdom').JSDOM;
const minify = require('html-minifier').minify;
const emoji = require('node-emoji');
const entities = require('html-entities').AllHtmlEntities;

const minifyOptions = {
  collapseWhitespace: true,
  conservativeCollapse: true,
  removeComments: true
};

let bios = new Set();
let gloss = new Set();
let data = {steps: []};
let currentStep = null;
let currentDirectory = null;
let globalPug = '';  // Global Pug code at the beginning of chapters
let originalP = null;  // Caching of unparsed paragraphs (for blockquotes)


// -----------------------------------------------------------------------------
// Helper Functions

function last(x) {
  return x[x.length - 1];
}

function emojiImg(symbol, name) {
  const code = symbol.codePointAt(0).toString(16);
  return `<img class="emoji" width="20" height="20" src="/images/emoji/${code}.png" alt="${name}"/>`;
}

function nodes(element) {
  let result = [];
  for (let c of element.children) {
    result.push(...nodes(c));
    result.push(c);
  }
  return result;
}


// -----------------------------------------------------------------------------
// Markdown Extensions

// HTML Tag Wrappers using ::: and indentation.
function blockIndentation(source) {
  const lines = source.split('\n');
  let closeTags = [];
  let nested = [];

  for (let i = 0; i < lines.length; ++i) {
    if (!lines[i].startsWith(':::')) continue;
    const tag = lines[i].slice(4);

    if (!tag) {
      lines[i] = '\n' + closeTags.pop() + '\n';
      nested.pop();
      continue;
    }

    if (tag.startsWith('column')) {
      let col = pug.render(tag.replace('column', 'div')).split('</')[0];
      col = col.replace(/width="([0-9]+)"/, 'style="width: $1px"');
      if (last(nested) === 'column') {
        lines[i] = '\n</div>' + col + '\n';
      } else {
        lines[i] = '<div class="row padded">' + col + '\n';
        nested.push('column');
        closeTags.push('</div></div>')
      }
    } else if (tag.startsWith('tab')) {
      let col = pug.render(tag.replace('tab', '.tab')).split('</')[0];
      if (last(nested) === 'tab') {
        lines[i] = '\n</div>' + col + '\n';
      } else {
        lines[i] = '<x-tabbox>' + col + '\n';
        nested.push('tab');
        closeTags.push('</div></x-tabbox>')
      }
    } else {
      let wrap = pug.render(tag).split('</');
      closeTags.push('</' + wrap[1]);
      lines[i] = wrap[0] + '\n';
      nested.push('');
    }
  }

  return lines.join('\n');
}

function blockAttributes(node) {
  let lastChild = node.childNodes[0]; //[node.childNodes.length - 1];
  if (!lastChild || lastChild.nodeType !== 3) return;

  let match = lastChild.textContent.match(/^\{([^\}]+)\}/);
  if (!match) return;

  lastChild.textContent = lastChild.textContent.replace(match[0], '');

  let div = node.ownerDocument.createElement('div');
  div.innerHTML = pug.render(match[1]);

  let replaced = div.children[0];

  if (replaced.tagName === 'DIV') {
    const attributes = Array.from(replaced.attributes);
    for (let a of attributes) node.setAttribute(a.name, a.value);
  } else {
    while (node.firstChild) replaced.appendChild(node.firstChild);
    node.parentNode.replaceChild(replaced, node);
  }
}

function parseParagraph(text) {
  text = text
    .replace(/\[\[([^\]]+)]]/g, function(x, body) {
      if (body.split('|').length > 1) return `<x-blank choices="${body}"></x-blank>`;
      return `<x-blank-input solution="${body}"></x-blank-input>`;
    })
    .replace(/\${([^}]+)}{([^}]+)}/g, '<x-var bind="$2">${$1}</x-var>')
    .replace(/\${([^}]+)}(?!<\/x-var>)/g, '<span class="var">${$1}</span>');
  return emoji.emojify(text, x => x, emojiImg);
}


// -----------------------------------------------------------------------------
// Custom Marked Renderer

const renderer = new marked.Renderer();

renderer.link = function(href, title, text) {
  if (href.startsWith('gloss:')) {
    let id = href.slice(6);
    gloss.add(id);
    return `<x-gloss xid="${id}">${text}</x-gloss>`;
  }

  if (href.startsWith('bio:')) {
    let id = href.slice(4);
    bios.add(id);
    return `<x-bio xid="${id}">${text}</x-bio>`;
  }

  if (href.startsWith('target:')) {
    let id = href.slice(7);
    return `<span class="step-target" data-to="${id}">${text}</span>`;
  }

  const href1 = entities.decode(href);
  if (href1.startsWith('->')) {
    return `<x-target to="${href1.slice(2).trim()}">${text}</x-target>`;
  }

  return `<a href="${href}" target="_blank">${text}</a>`;
};

renderer.heading = function (text, level) {
  if (level === 1) {
    data.title = text;
    return '';
  }
  return `<h${level}>${text}</h${level}>`;
};

renderer.codespan = function(code) {
  let maths = ascii2mathml(entities.decode(code), {bare: true});
  maths = maths.replace(/<mo>-<\/mo>/g, '<mo>−</mo>')
    .replace(/\s*accent="true"/g, '')
    .replace(/lspace="0" rspace="0">′/g, '>′')
    .replace(/>(.)<\/mo>/g, (_, mo) =>  ` value="${mo}">${mo}</mo>`);
  return `<span class="math">${maths}</span>`;
};

renderer.blockquote = function(quote) {
  const documentData = yaml.parse(originalP || quote);
  Object.assign(currentStep || data, documentData);
  return '';
};

renderer.hr = function() {
  let previous = currentStep;
  currentStep = {};
  data.steps.push(currentStep);
  return previous ? '</x-step><x-step>' : '<x-step>';
};

// Indented Pug HTML blocks
renderer.code = function(code) {
  if (!currentStep) {
    globalPug += code + '\n\n';
    return '';
  }
  return pug.render(globalPug + code, {filename: currentDirectory + '/content.pug'});
};

renderer.listitem = function(text) {
  return '<li>' + parseParagraph(text) + '</li>';
};

renderer.paragraph = function(text) {
  originalP = text;
  return '<p>' + parseParagraph(text) + '</p>';
};


// -----------------------------------------------------------------------------
// Run Markdown Parser

module.exports.renderer = renderer;

module.exports.parseFull = function(id, content, path) {
  bios = new Set();
  gloss = new Set();
  data = {steps: []};
  currentStep = null;
  currentDirectory = path;
  globalPug = '';

  // Replace relative image URLs
  content = content.replace(/(url\(|src="|href="|background=")images\//g, `$1/resources/${id}/images/`);

  // Rename special attributes
  content = content.replace(/when=/g, 'data-when=');
  content = content.replace(/delay=/g, 'data-delay=');
  content = content.replace(/animation=/g, 'data-animation=');

  // Custom Markdown Extensions
  content = blockIndentation(content);

  // Parse Markdown (but override HTML detection)
  const lexer = new marked.Lexer();
  lexer.rules.html = /^<.*[\n]{2,}/;
  const tokens = lexer.lex(content);
  const parsed = marked.Parser.parse(tokens, {renderer});

  const doc = (new JSDom(parsed + '</x-step>')).window.document;

  // Parse custom element attributess
  for (let n of nodes(doc.body)) blockAttributes(n);

  // Parse markdown inside HTML elements with .md class
  const $md = doc.body.querySelectorAll('.md');
  for (let i = 0; i < $md.length; ++i) {
    $md[i].classList.remove('md');
    $md[i].innerHTML = marked($md[i].innerHTML, {renderer})
      .replace(/^<p>|<\/p>$/g, '');
  }

  // Add the [parent] attribute as class to all elements parents
  const $parents = doc.body.querySelectorAll('[parent]');
  for (let $p of $parents) {
    const classes = $p.getAttribute('parent').split(' ');
    $p.removeAttribute('parent');
    $p.parentNode.classList.add(...classes);
  }

  // Add IDs, classes and goals for steps
  const $steps = doc.body.querySelectorAll('x-step');
  for (let i = 0; i < $steps.length; ++i) {
    let d = data.steps[i];
    if (!d.id) d.id = 'step-' + i;
    $steps[i].id = d.id;
    if (d.goals) $steps[i].setAttribute('goals', d.goals);
    if (d.class) $steps[i].setAttribute('class', d.class);
  }

  // Generate HTML for individual steps
  const steps = {};
  for (let $s of doc.body.querySelectorAll('x-step'))
    steps[$s.id] = minify($s.outerHTML, minifyOptions);

  // Generate HTML for the entire page
  const html = minify(doc.body.innerHTML, minifyOptions);

  return {html, bios, gloss, data, steps};
};
