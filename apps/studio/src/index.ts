import * as path from 'path';

/** Serve this directory at / with /api provided by a compatible platform host. */
export function studioAssetsDirectory(): string { return path.join(__dirname, 'client'); }
