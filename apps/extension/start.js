import { findServer } from './gloss.js';

const path = new URLSearchParams(location.search).get('path') ?? '/';

async function poll() {
  const server = await findServer();
  if (server) {
    location.replace(`${server}${path}`);
  } else {
    setTimeout(poll, 1000);
  }
}

void poll();
