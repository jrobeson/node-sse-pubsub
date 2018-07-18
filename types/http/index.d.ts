import * as http from 'http';

declare module 'http' {
  export interface IncomingHttpHeaders {
    'last-event-id'?: string;
  }
}
