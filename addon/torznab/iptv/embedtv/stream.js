import { Readable } from 'node:stream';

export function streamToResponse(response, destination) {
  if (!response?.body) {
    destination.end();
    return;
  }
  Readable.fromWeb(response.body).pipe(destination);
}
