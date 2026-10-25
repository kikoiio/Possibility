import { access } from 'node:fs/promises';

export async function resolve(specifier, context, nextResolve) {
  if (specifier.endsWith('.js') && context.parentURL?.startsWith('file:')) {
    const typescriptSpecifier = `${specifier.slice(0, -3)}.ts`;
    try {
      await access(new URL(typescriptSpecifier, context.parentURL));
      return nextResolve(typescriptSpecifier, context);
    } catch {
      // Keep normal JavaScript resolution when this source file has no TS sibling.
    }
  }
  return nextResolve(specifier, context);
}
