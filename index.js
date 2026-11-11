/**
 * Package entry: the host half of dsh-plugin-portara.
 *
 * The browser half lives in `client.js` and is linked through `dsh.client` in
 * `package.json`; both halves ride this one bundle row.
 */
export { apply, inject, name, readOptions } from './src/host/index.js'
