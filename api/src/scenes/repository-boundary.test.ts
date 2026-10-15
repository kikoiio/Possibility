import { readdirSync, readFileSync } from 'node:fs'
import { dirname, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as ts from 'typescript'
import { expect, it } from 'vitest'

const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const storageRoot = resolve(sourceRoot, 'scenes/storage')
const publicBarrel = resolve(sourceRoot, 'scenes/repository.ts')
const tsconfigPath = resolve(sourceRoot, '../tsconfig.json')
const tsconfig = ts.readConfigFile(tsconfigPath, ts.sys.readFile)
const compilerOptions = ts.parseJsonConfigFileContent(tsconfig.config, ts.sys, dirname(tsconfigPath)).options

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = resolve(directory, entry.name)
    return entry.isDirectory() ? sourceFiles(path) : entry.isFile() && /\.(?:ts|tsx|mts|cts)$/.test(entry.name) ? [path] : []
  })
}

function isWithin(directory: string, path: string): boolean {
  const pathFromDirectory = relative(directory, path)
  return pathFromDirectory === '' || (!pathFromDirectory.startsWith('..') && !pathFromDirectory.startsWith('/'))
}

function moduleSpecifiers(sourceFile: ts.SourceFile): string[] {
  const specifiers: string[] = []
  const visit = (node: ts.Node) => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node))
      && node.moduleSpecifier && ts.isStringLiteralLike(node.moduleSpecifier)) {
      specifiers.push(node.moduleSpecifier.text)
    } else if (ts.isImportEqualsDeclaration(node)
      && ts.isExternalModuleReference(node.moduleReference)
      && node.moduleReference.expression && ts.isStringLiteralLike(node.moduleReference.expression)) {
      specifiers.push(node.moduleReference.expression.text)
    } else if (ts.isImportTypeNode(node)
      && ts.isLiteralTypeNode(node.argument)
      && ts.isStringLiteralLike(node.argument.literal)) {
      specifiers.push(node.argument.literal.text)
    } else if (ts.isCallExpression(node)
      && (node.expression.kind === ts.SyntaxKind.ImportKeyword
        || (ts.isIdentifier(node.expression) && node.expression.text === 'require'))
      && node.arguments.length === 1 && ts.isStringLiteralLike(node.arguments[0])) {
      specifiers.push(node.arguments[0].text)
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  return specifiers
}

it('keeps scene storage imports behind the public repository barrel', () => {
  const violations: string[] = []

  for (const sourceFile of sourceFiles(sourceRoot)) {
    const source = ts.createSourceFile(sourceFile, readFileSync(sourceFile, 'utf8'), ts.ScriptTarget.Latest, true)
    for (const specifier of moduleSpecifiers(source)) {
      const importedPath = ts.resolveModuleName(specifier, sourceFile, compilerOptions, ts.sys).resolvedModule?.resolvedFileName
        ?? (specifier.startsWith('.') ? resolve(dirname(sourceFile), specifier) : null)
      if (!importedPath || !isWithin(storageRoot, importedPath)) continue
      if (sourceFile === publicBarrel || isWithin(storageRoot, sourceFile)) continue
      violations.push(`${relative(sourceRoot, sourceFile)} imports ${specifier}`)
    }
  }

  expect(violations).toEqual([])
})
