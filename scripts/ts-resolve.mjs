/**
 * Lets `node --test` resolve the extensionless relative imports that the app
 * source uses.
 *
 * Next and tsc resolve `./apify` to `./apify.ts` via "moduleResolution":
 * "bundler". Node's ESM resolver does not, and switching the source to
 * explicit `.ts` specifiers would need allowImportingTsExtensions, which
 * conflicts with the build. So the hook is applied to the test runner only —
 * the application never loads it.
 */
import { register } from 'node:module';

register(
  'data:text/javascript,' + encodeURIComponent(`
    export async function resolve(specifier, context, next) {
      if (specifier.startsWith('.') && !/\\.[a-zA-Z0-9]+$/.test(specifier)) {
        try {
          return await next(specifier + '.ts', context);
        } catch {
          // Fall through to the default resolution and its error.
        }
      }
      return next(specifier, context);
    }
  `),
  import.meta.url,
);
