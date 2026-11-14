import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** A fresh empty folder for a test's files. */
export const tmp = () => mkdtempSync(join(tmpdir(), 'pmw-test-'));
