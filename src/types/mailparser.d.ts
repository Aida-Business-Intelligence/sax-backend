declare module 'mailparser' {
  export function simpleParser(source: Buffer | import('stream').Readable | string): Promise<{
    text?: string;
    html?: string | false;
    subject?: string;
    from?: { text: string };
    to?: { text: string };
  }>;
}
