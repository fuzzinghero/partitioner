import { readdir, readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import ts from 'typescript';

const captureCalls = new Set([
  'fetch',
  'XMLHttpRequest',
  'WebSocket',
  'DOMParser',
  'eval',
  'Function',
]);
const storage = new Set(['localStorage', 'sessionStorage', 'indexedDB']);
const referenceName = (node) => {
  if (ts.isIdentifier(node)) return node.text;
  if (ts.isPropertyAccessExpression(node)) return node.name.text;
  if (
    ts.isElementAccessExpression(node) &&
    node.argumentExpression &&
    ts.isStringLiteralLike(node.argumentExpression)
  )
    return node.argumentExpression.text;
  if (
    ts.isParenthesizedExpression(node) ||
    ts.isNonNullExpression(node) ||
    ts.isAsExpression(node) ||
    ts.isTypeAssertionExpression(node)
  )
    return referenceName(node.expression);
};

/** Development guard for direct module dependencies and browser capture APIs. */
export async function checkBoundary(root) {
  for (const name of await readdir(resolve(root, 'src'))) {
    if (!name.endsWith('.ts')) continue;
    const source = ts.createSourceFile(
      name,
      await readFile(resolve(root, 'src', name), 'utf8'),
      ts.ScriptTarget.Latest,
      true,
    );
    const test = name.endsWith('.test.ts');
    const checkTarget = (target) => {
      const allowed =
        (target.startsWith('./') && !target.includes('..')) ||
        (target.startsWith('node:') && test) ||
        (target === 'react' && name === 'react.ts') ||
        (target === 'vitest' && test);
      assert.ok(allowed, `Package boundary violation in ${name}: ${target}`);
    };
    const visit = (node) => {
      if (
        (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
        node.moduleSpecifier &&
        ts.isStringLiteralLike(node.moduleSpecifier)
      )
        checkTarget(node.moduleSpecifier.text);
      if (
        ts.isImportTypeNode(node) &&
        ts.isLiteralTypeNode(node.argument) &&
        ts.isStringLiteralLike(node.argument.literal)
      )
        checkTarget(node.argument.literal.text);
      assert.ok(
        !(ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)),
        `Require import in ${name}`,
      );
      if (ts.isCallExpression(node))
        assert.ok(
          node.expression.kind !== ts.SyntaxKind.ImportKeyword &&
            referenceName(node.expression) !== 'require',
          `Dynamic import in ${name}`,
        );
      if (!test) {
        if (ts.isCallExpression(node) || ts.isNewExpression(node))
          assert.ok(
            !captureCalls.has(referenceName(node.expression)),
            `Disallowed capture sink in ${name}`,
          );
        if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node))
          assert.ok(
            !storage.has(referenceName(node.expression)) && !storage.has(referenceName(node)),
            `Disallowed capture sink in ${name}`,
          );
        if (
          ts.isBinaryExpression(node) &&
          node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
          node.operatorToken.kind <= ts.SyntaxKind.LastAssignment
        )
          assert.ok(referenceName(node.left) !== 'innerHTML', `Disallowed capture sink in ${name}`);
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await checkBoundary(resolve(dirname(fileURLToPath(import.meta.url)), '..'));
  console.log(
    'Package boundary passed: local processing modules. Optional React adapter. No UI/platform imports or capture sinks.',
  );
}
