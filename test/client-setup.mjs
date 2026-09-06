// jsdom lacks Blob.arrayBuffer()/text(); use Node's Web API implementation.
import { Blob, File } from 'node:buffer';
Object.assign(globalThis, { Blob, File });
