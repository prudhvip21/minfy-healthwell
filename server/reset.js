/**
 * Wipe and rebuild the demo database.
 *
 * Parsed plans are expensive (one GPT-5 call per document), so by default a
 * reset keeps the stored parse and only rebuilds the state a demo mutates:
 * check-ins, proposals, nudges, traces and history. Pass { reparse: true }
 * to go all the way back to the documents.
 */

import { wipe } from './db.js';
import { importPlans } from './planImport.js';

export async function resetDemo({ reparse = false, log = console.log } = {}) {
  wipe({ keepPlans: !reparse });
  return importPlans({ force: reparse, log });
}

if (import.meta.url === (await import('node:url')).pathToFileURL(process.argv[1]).href) {
  const reparse = process.argv.includes('--reparse');
  resetDemo({ reparse })
    .then((r) => { console.table(r); process.exit(0); })
    .catch((e) => { console.error(e); process.exit(1); });
}
