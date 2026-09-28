'use strict';

const vscode = require('vscode');
const path = require('path');
const fs = require('fs');

const CONFIG_SECTION = 'quickSeeLinks';
const OPEN_COMMAND = 'quickSeeLinks.openTarget';

/**
 * Escapes a string for safe use inside a RegExp.
 */
function escapeRegExp(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Builds the regex that matches "<tag> <path>[:line[:col]]" for all configured tags.
 * Example match: "@see ../php/path/class.php:123"
 */
function buildRegex() {
  const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
  const tags = config.get('tags', ['@see', '@link']);
  if (!tags || tags.length === 0) return null;

  const tagAlternation = tags.map(escapeRegExp).join('|');
  // (?<![\w@]) -> tag must not be glued to a preceding word char (avoids matching inside other words)
  // group 1: path (no whitespace, no ':' or '#' so it doesn't eat the line number / symbol)
  // group 2: optional symbol chain ("#fetch", "#x_grid_data.fetch")
  // group 3: optional line number
  // group 4: optional column number
  const pattern = `(?<![\\w@])(?:${tagAlternation})\\s+([^\\s:#]+)(?:#([\\w$]+(?:\\.[\\w$]+)*)|(?::(\\d+))?(?::(\\d+))?)`;
  return new RegExp(pattern, 'g');
}

/**
 * Resolves a raw path found in a comment to an absolute filesystem path.
 * - Absolute paths are used as-is.
 * - Paths starting with "/" are resolved from the workspace root (if enabled), else filesystem root.
 * - Everything else is resolved relative to the folder of the current document.
 */
function resolveTargetPath(document, rawPath) {
  if (path.isAbsolute(rawPath) && fs.existsSync(rawPath)) {
    return rawPath;
  }

  const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
  const rootRelativeEnabled = config.get('rootRelativePrefix.enabled', true);

  if (rootRelativeEnabled && rawPath.startsWith('/')) {
    const folder = vscode.workspace.getWorkspaceFolder(document.uri);
    if (folder) {
      const candidate = path.join(folder.uri.fsPath, rawPath.slice(1));
      if (fs.existsSync(candidate)) return candidate;
    }
  }

  // Relative to the file containing the comment.
  const relToFile = path.resolve(path.dirname(document.uri.fsPath), rawPath);
  if (fs.existsSync(relToFile)) return relToFile;

  // Fallback: try relative to each workspace folder root.
  const folders = vscode.workspace.workspaceFolders || [];
  for (const folder of folders) {
    const candidate = path.resolve(folder.uri.fsPath, rawPath);
    if (fs.existsSync(candidate)) return candidate;
  }

  return null; // not found -> no link will be created
}

class SeeLinkProvider {
  provideDocumentLinks(document) {
    const regex = buildRegex();
    if (!regex) return [];

    const text = document.getText();
    const links = [];
    let match;

    while ((match = regex.exec(text)) !== null) {
      const [full, rawPath, symbol, lineStr, colStr] = match;
      const targetPath = resolveTargetPath(document, rawPath);
      if (!targetPath) continue; // skip dead links instead of offering to "create" a file

      const line = lineStr ? parseInt(lineStr, 10) : undefined;
      const col = colStr ? parseInt(colStr, 10) : undefined;

      // Range of "path[#symbol|:line[:col]]" within the match (not the tag itself).
      const pathStartInMatch = full.indexOf(rawPath);
      const startOffset = match.index + pathStartInMatch;
      const endOffset = match.index + full.length;

      const range = new vscode.Range(
        document.positionAt(startOffset),
        document.positionAt(endOffset)
      );

      const args = [{ fsPath: targetPath, line, col, symbol }];
      const commandUri = vscode.Uri.parse(
        `command:${OPEN_COMMAND}?${encodeURIComponent(JSON.stringify(args))}`
      );

      const link = new vscode.DocumentLink(range, commandUri);
      link.tooltip = `Open ${path.relative(path.dirname(document.uri.fsPath), targetPath)}${
        symbol ? '#' + symbol : line ? ':' + line : ''
      }`;
      links.push(link);
    }

    return links;
  }
}

/** Symbol name without "(...)" suffixes some language servers add. */
function symbol_name(s) {
  return s.name.replace(/\(.*$/, '').trim();
}

function symbol_range(s) {
  return s.range || s.location.range;
}

async function get_symbols(uri) {
  try {
    return (await vscode.commands.executeCommand('vscode.executeDocumentSymbolProvider', uri)) || [];
  } catch (e) {
    return [];
  }
}

/** Finds the range of "a.b.c" in the document: walks the symbol tree, then searches it flat, then plain text. */
async function find_symbol_range(doc, chain) {
  const names = chain.split('.');
  const last = names[names.length - 1];
  const symbols = await get_symbols(doc.uri);

  let level = symbols;
  let found = null;
  for (const name of names) {
    found = level.find((s) => symbol_name(s) === name);
    if (!found) break;
    level = found.children || [];
  }
  if (found) return symbol_range(found);

  const stack = [...symbols];
  while (stack.length) {
    const s = stack.shift();
    if (symbol_name(s) === last) return symbol_range(s);
    stack.push(...(s.children || []));
  }

  const word = escapeRegExp(last.replace(/^\$/, ''));
  const text = doc.getText();
  const m =
    new RegExp(`\\bfunction\\s+&?${word}\\b`).exec(text) ||
    new RegExp(`\\b${word}\\s*\\(`).exec(text);
  return m ? new vscode.Range(doc.positionAt(m.index), doc.positionAt(m.index)) : null;
}

/** "a.b.c" chain of the innermost symbols containing pos, or null. */
async function symbol_chain_at(doc, pos) {
  const names = [];
  let level = await get_symbols(doc.uri);
  for (;;) {
    const s = level.find((x) => symbol_range(x).contains(pos));
    if (!s) break;
    names.push(symbol_name(s));
    level = s.children || [];
  }
  return names.length ? names.join('.') : null;
}

async function copy_link() {
  const editor = vscode.window.activeTextEditor;
  if (!editor) return;

  const doc = editor.document;
  const pos = editor.selection.active;
  const folder = vscode.workspace.getWorkspaceFolder(doc.uri);
  const rel_path = folder
    ? path.relative(folder.uri.fsPath, doc.uri.fsPath).split(path.sep).join('/')
    : doc.uri.fsPath;

  // Enclosing class/method/function/variable, else the word under the cursor, else the line.
  let chain = await symbol_chain_at(doc, pos);
  if (!chain) {
    const word_range = doc.getWordRangeAtPosition(pos, /[\w$]+/);
    chain = word_range ? doc.getText(word_range) : null;
  }
  const suffix = chain ? '#' + chain : ':' + (pos.line + 1);

  const tag = vscode.workspace.getConfiguration(CONFIG_SECTION).get('tags', ['@see'])[0] || '@see';
  const text = `${tag} ${rel_path}${suffix}`;
  await vscode.env.clipboard.writeText(text);
  vscode.window.setStatusBarMessage(`Copied: ${text}`, 3000);
}

async function openTarget(arg) {
  const { fsPath, line, col, symbol } = arg || {};
  if (!fsPath || !fs.existsSync(fsPath)) {
    vscode.window.showErrorMessage(`Quick @see Links: file not found — ${fsPath}`);
    return;
  }

  const doc = await vscode.workspace.openTextDocument(fsPath);
  const editor = await vscode.window.showTextDocument(doc, { preview: false });

  if (symbol) {
    const range = await find_symbol_range(doc, symbol);
    if (!range) {
      vscode.window.showWarningMessage(`Quick @see Links: "${symbol}" not found in ${fsPath}`);
      return;
    }
    const pos = range.start;
    editor.selection = new vscode.Selection(pos, pos);
    editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
  } else if (line) {
    const ln = Math.max(0, line - 1);
    const cn = col ? Math.max(0, col - 1) : 0;
    const pos = new vscode.Position(ln, cn);
    editor.selection = new vscode.Selection(pos, pos);
    editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
  }
}

function activate(context) {
  const selector = { scheme: 'file' }; // any language/file type

  let providerDisposable = vscode.languages.registerDocumentLinkProvider(
    selector,
    new SeeLinkProvider()
  );
  context.subscriptions.push(providerDisposable);

  context.subscriptions.push(vscode.commands.registerCommand(OPEN_COMMAND, openTarget));
  context.subscriptions.push(vscode.commands.registerCommand('quickSeeLinks.copyLink', copy_link));

  // No need to re-register on config change: provideDocumentLinks reads config live,
  // and VS Code re-invokes the provider on every document change/visibility change.
}

function deactivate() {}

module.exports = { activate, deactivate };
